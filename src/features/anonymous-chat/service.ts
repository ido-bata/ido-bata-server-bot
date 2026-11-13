/**
 * `/anon` posting service (ADR-0003).
 *
 * Pipeline per invocation:
 *   audit-health gate → validate → cooldown → deny-list →
 *   channel/guild/member resolution → effective permissions (user +
 *   bot) → thread state → consent → seal+append audit → post.
 *
 * Anonymity rules enforced here:
 *   - No user id, message body, or interaction object is ever logged;
 *     failures are logged as safe structured fields only
 *     (`errors.ts`) — never `error.message`/raw Discord payloads.
 *   - Audit mode seals the author mapping and appends it BEFORE the
 *     public post, so no public anonymous message can exist without a
 *     durable audit record. A failed send leaves only an orphan
 *     record (over-recording — the safe direction, swept by
 *     retention); a seal/append failure rejects the post before any
 *     public side effect.
 *   - Audit is MANDATORY (Issue #118, ADR-0003 §3): unless the audit
 *     sink is `active`, `/anon` refuses every post — there is no
 *     unlogged posting mode. `auditState: "disabled"` (no public key
 *     configured) and `"error"` (configured but broken, or a
 *     posted-record write failed) both fail closed.
 *   - Two-phase records: an `attempt` record (with a random
 *     `attemptId`) is sealed+appended BEFORE the public send; a
 *     `posted` record carrying the real `messageId` is appended
 *     immediately after a successful send. A posted-record failure
 *     deletes the message best-effort, flips `auditState` to
 *     `"error"`, and refuses the post — no live anonymous message
 *     may lack exact messageId correlation.
 */

import { PermissionFlagsBits } from "discord.js";
import {
  type AnonAuditAttemptPlaintext,
  type AnonAuditPostedPlaintext,
  newAnonAttemptId,
} from "./audit-crypto.js";
import type { AnonAuditSink } from "./audit-store.js";
import { createAnonAuditSink } from "./audit-store.js";
import type { AnonymousChatConfig } from "./config.js";
import { safeErrorFields } from "./errors.js";
import type { AnonChannelLike, AnonGuildLike, AnonMemberLike } from "./permissions.js";
import {
  canPostWith,
  isPrivateThread,
  isThreadChannel,
  requiredSendBit,
  resolveEffectivePermissions,
} from "./permissions.js";
import { AnonCooldown } from "./rate-limit.js";

export type AnonPostInput = {
  userId: string;
  guildId: string;
  channelId: string;
  message: string;
};

export type AnonPostResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "invalid_message"
        | "cooldown"
        | "denied"
        | "bot_permission_denied"
        | "unavailable"
        | "post_failed"
        | "audit_failed";
      retryAfterMs?: number;
    };

export type AnonLogger = {
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
};

export type AnonymousChatServiceDeps = {
  config: AnonymousChatConfig;
  fetchChannel: (channelId: string) => Promise<AnonChannelLike | null>;
  fetchGuild: (guildId: string) => Promise<AnonGuildLike | null>;
  fetchMember: (guild: AnonGuildLike, userId: string) => Promise<AnonMemberLike | null>;
  fetchBotMember: (guild: AnonGuildLike) => Promise<AnonMemberLike | null>;
  isThreadMember?: (channel: AnonChannelLike, userId: string) => Promise<boolean>;
  /**
   * Consent gate for audit writes (message-history scope). When
   * undefined the consent subsystem is not deployed and no gate is
   * applied — same precedent as poll/reminder. Must resolve `false`
   * (never throw) on deny; throws are treated as deny.
   */
  authorizeAudit?: (userId: string) => Promise<boolean>;
  /** Injectable audit sink; built from `config.audit` when omitted. */
  audit?: AnonAuditSink | null;
  /**
   * Called on every auditState transition (including the initial state
   * chosen at construction) so the composition root can reflect a
   * runtime `active → error` degradation into the status store / TUI.
   */
  onAuditStateChange?: (state: AnonymousChatService["auditState"]) => void;
  now?: () => number;
  logger?: AnonLogger;
};

export type AnonymousChatService = {
  post: (input: AnonPostInput) => Promise<AnonPostResult>;
  /**
   * Audit persistence state: `active` = records are written,
   * `disabled` = no public key configured — `/anon` refuses all posts
   * (audit is mandatory, Issue #118), `error` = audit was configured
   * but the sink failed to initialize or a posted-record write
   * failed — `/anon` refuses all posts. Transitions to `"error"` at
   * runtime are possible (posted-record failure).
   */
  auditState: "disabled" | "active" | "error";
};

function isSupportedChannel(channel: AnonChannelLike): boolean {
  return (
    channel.guildId !== null &&
    typeof channel.isTextBased === "function" &&
    channel.isTextBased() &&
    typeof channel.send === "function"
  );
}

async function isThreadMemberSafe(
  channel: AnonChannelLike,
  userId: string,
  deps: AnonymousChatServiceDeps,
): Promise<boolean> {
  if (!deps.isThreadMember) {
    // Cannot verify membership → fail closed.
    return false;
  }
  try {
    return await deps.isThreadMember(channel, userId);
  } catch {
    return false;
  }
}

export function createAnonymousChatService(deps: AnonymousChatServiceDeps): AnonymousChatService {
  const { config, logger } = deps;
  const cooldown = new AnonCooldown(config.cooldownMs, deps.now);

  // Build the audit sink once. Audit is MANDATORY (Issue #118):
  // `auditState` other than `"active"` makes every post fail closed —
  // an operator misconfiguration can never produce unlogged anonymous
  // posts (ADR-0003 §3). `auditState` is mutable: a posted-record
  // failure after a successful send degrades it to `"error"`.
  // Retention must not depend on new posts or a restart: sweep on a
  // timer as well as at startup and before each append. `unref` keeps
  // the interval from holding the process open; the sweep is
  // idempotent so overlapping or missed ticks are harmless.
  const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
  const sweepAudit = (sink: AnonAuditSink) => {
    void sink.sweep().catch((error: unknown) => {
      logger?.warn(safeErrorFields(error), "anonymous-chat: audit retention sweep failed");
    });
  };

  let audit = deps.audit;
  let auditState: AnonymousChatService["auditState"];
  const setAuditState = (next: AnonymousChatService["auditState"]) => {
    if (auditState === next) {
      return;
    }
    auditState = next;
    deps.onAuditStateChange?.(next);
  };
  if (audit === undefined && config.audit) {
    try {
      audit = createAnonAuditSink(config.audit);
      sweepAudit(audit);
      setInterval(() => sweepAudit(audit as AnonAuditSink), RETENTION_SWEEP_INTERVAL_MS).unref();
      setAuditState("active");
    } catch (error) {
      logger?.error(
        safeErrorFields(error),
        "anonymous-chat: failed to initialize audit sink; /anon disabled",
      );
      audit = null;
      setAuditState("error");
    }
  } else if (audit) {
    sweepAudit(audit);
    setInterval(() => sweepAudit(audit as AnonAuditSink), RETENTION_SWEEP_INTERVAL_MS).unref();
    setAuditState("active");
  } else {
    // No public key configured → "disabled": /anon refuses every
    // post. This is NOT a posting mode — audit is mandatory.
    setAuditState("disabled");
  }

  async function resolveMemberPermissions(
    channel: AnonChannelLike,
    member: AnonMemberLike,
    guild: AnonGuildLike,
  ) {
    try {
      return await resolveEffectivePermissions({
        channel,
        member,
        guild,
        fetchChannel: deps.fetchChannel,
      });
    } catch (error) {
      logger?.warn(safeErrorFields(error), "anonymous-chat: permission resolution failed");
      return null;
    }
  }

  return {
    get auditState() {
      return auditState;
    },
    async post(input) {
      // Audit is mandatory: anything other than an active sink
      // ("disabled" = no key configured, "error" = broken sink or a
      // prior posted-record failure) refuses ALL posts — never
      // degrade to unlogged anonymity. Checked before message
      // validation so a broken deployment reports `unavailable` for
      // every input and does not burn users' cooldown windows.
      if (auditState !== "active" || !audit) {
        return { ok: false, reason: "unavailable" };
      }
      const text = input.message.trim();
      if (text.length === 0 || text.length > config.maxMessageLength) {
        return { ok: false, reason: "invalid_message" };
      }
      // Cooldown is consumed on every attempt that passes message
      // validation — including attempts later denied — to bound
      // permission probing and API abuse (ADR-0003 §2).
      const retryAfterMs = cooldown.hit(input.userId);
      if (retryAfterMs > 0) {
        return { ok: false, reason: "cooldown", retryAfterMs };
      }

      if (config.denyChannelIds.has(input.channelId)) {
        return { ok: false, reason: "denied" };
      }

      let channel: AnonChannelLike | null;
      try {
        channel = await deps.fetchChannel(input.channelId);
      } catch (error) {
        logger?.warn(safeErrorFields(error), "anonymous-chat: channel fetch failed");
        return { ok: false, reason: "denied" };
      }
      if (!channel || channel.guildId !== input.guildId || !isSupportedChannel(channel)) {
        return { ok: false, reason: "denied" };
      }

      const isThread = isThreadChannel(channel);
      if (isThread) {
        // `locked` is `boolean | null` on discord.js ThreadChannel; an
        // unknown/null state must fail closed for a posting decision.
        if (channel.locked !== false) {
          return { ok: false, reason: "denied" };
        }
      }

      let guild: AnonGuildLike | null;
      try {
        guild = await deps.fetchGuild(input.guildId);
      } catch (error) {
        logger?.warn(safeErrorFields(error), "anonymous-chat: guild fetch failed");
        return { ok: false, reason: "denied" };
      }
      if (!guild) {
        return { ok: false, reason: "denied" };
      }

      let member: AnonMemberLike | null;
      try {
        member = await deps.fetchMember(guild, input.userId);
      } catch (error) {
        logger?.warn(safeErrorFields(error), "anonymous-chat: member fetch failed");
        return { ok: false, reason: "denied" };
      }
      if (!member) {
        return { ok: false, reason: "denied" };
      }

      const userPermissions = await resolveMemberPermissions(channel, member, guild);
      if (!userPermissions || !canPostWith(channel, userPermissions)) {
        return { ok: false, reason: "denied" };
      }

      // Private threads: the invoking member can post only if it is a
      // thread member or holds ManageThreads (which also covers
      // Administrator/guild owner — resolveEffectivePermissions returns
      // all bits for them). Checked AFTER permission resolution so the
      // moderator path uses the same fresh bits as the send check.
      if (
        isPrivateThread(channel) &&
        !userPermissions.has(PermissionFlagsBits.ManageThreads) &&
        !(await isThreadMemberSafe(channel, input.userId, deps))
      ) {
        return { ok: false, reason: "denied" };
      }

      let botMember: AnonMemberLike | null;
      try {
        botMember = await deps.fetchBotMember(guild);
      } catch (error) {
        logger?.warn(safeErrorFields(error), "anonymous-chat: bot member fetch failed");
        return { ok: false, reason: "denied" };
      }
      if (!botMember) {
        return { ok: false, reason: "denied" };
      }
      const botPermissions = await resolveMemberPermissions(channel, botMember, guild);
      const sendBit = requiredSendBit(channel);
      if (!botPermissions?.has(PermissionFlagsBits.ViewChannel) || !botPermissions.has(sendBit)) {
        return { ok: false, reason: "bot_permission_denied" };
      }

      // Private threads: the bot can post only if it is a thread member
      // or holds ManageThreads. Without this preflight the send would
      // fail with a generic API error instead of a clean denial.
      if (
        isPrivateThread(channel) &&
        !botPermissions.has(PermissionFlagsBits.ManageThreads) &&
        !(await isThreadMemberSafe(channel, botMember.id, deps))
      ) {
        return { ok: false, reason: "bot_permission_denied" };
      }

      // ---- consent pre-flight (fail closed before any public post) ----
      // The consent gate only exists when the consent subsystem is
      // deployed (`authorizeAudit` provided); audit itself is always
      // active here (enforced above).
      if (deps.authorizeAudit) {
        let consentOk: boolean;
        try {
          consentOk = await deps.authorizeAudit(input.userId);
        } catch {
          consentOk = false;
        }
        if (!consentOk) {
          logger?.warn({}, "anonymous-chat: audit consent denied");
          return { ok: false, reason: "unavailable" };
        }
      }

      // ---- audit phase 1: attempt record BEFORE the public post ----
      // The attempt record must be durable before any public side
      // effect: Discord assigns the message id only after send, so
      // phase 1 seals {attemptId, userId, guildId, channelId,
      // postedAt} and phase 2 (below) seals the same attemptId plus
      // the real messageId. A seal or append failure rejects the post
      // BEFORE sending — there is no window in which a public
      // anonymous message exists without its attempt record (a crash
      // between append and send leaves only an orphan record, which
      // is the safe direction; a send whose response is lost is still
      // covered because the attempt record already exists).
      const attemptId = newAnonAttemptId();
      const attemptPostedAt = new Date(deps.now?.() ?? Date.now()).toISOString();
      try {
        const attemptPlaintext: AnonAuditAttemptPlaintext = {
          v: 2,
          kind: "attempt",
          attemptId,
          userId: input.userId,
          guildId: input.guildId,
          channelId: input.channelId,
          postedAt: attemptPostedAt,
        };
        await audit.record({
          kind: "attempt",
          guildId: input.guildId,
          channelId: input.channelId,
          ciphertext: audit.seal(attemptPlaintext),
        });
      } catch (error) {
        // Never fall back to an unlogged post.
        logger?.error(safeErrorFields(error), "anonymous-chat: audit seal/append failed");
        return { ok: false, reason: "audit_failed" };
      }

      // ---- public post ----
      // If this throws, the attempt record remains as an orphan — a
      // record for a message that was never posted. That is the safe
      // direction (over-recording) and is swept by retention.
      // Re-check auditState at the send boundary: a concurrent post
      // may have flipped it to "error" (posted-record failure) while
      // this request was in preflight. Aborting here leaves only the
      // orphan attempt record — never an unlinked public message.
      if (auditState !== "active") {
        return { ok: false, reason: "unavailable" };
      }
      let sent: { id: string; delete: () => Promise<unknown> };
      try {
        sent = await channel.send({
          content: text,
          allowedMentions: { parse: [] },
        });
      } catch (error) {
        logger?.warn(safeErrorFields(error), "anonymous-chat: channel send failed");
        return { ok: false, reason: "post_failed" };
      }

      // ---- audit phase 2: posted record with the real messageId ----
      // Every acknowledged anonymous message must carry exact
      // messageId→author correlation. If this record cannot be
      // persisted, the live message would violate that invariant, so
      // we delete it best-effort, degrade auditState to "error" (no
      // further posts until operator intervention), and refuse.
      try {
        const postedPlaintext: AnonAuditPostedPlaintext = {
          v: 2,
          kind: "posted",
          attemptId,
          messageId: sent.id,
          userId: input.userId,
          guildId: input.guildId,
          channelId: input.channelId,
          postedAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
        };
        await audit.record({
          kind: "posted",
          guildId: input.guildId,
          channelId: input.channelId,
          ciphertext: audit.seal(postedPlaintext),
        });
      } catch (error) {
        // Flip auditState BEFORE awaiting the delete: a slow Discord
        // delete must not leave a window where new posts still pass
        // the active gate. The transition callback fires synchronously
        // so statusStore/TUI reflect the degradation immediately.
        setAuditState("error");
        try {
          await sent.delete();
        } catch {
          // Best effort only — the message may already be gone or the
          // delete may fail; auditState is already "error" so no
          // further unlinked posts accumulate.
        }
        logger?.error(
          safeErrorFields(error),
          "anonymous-chat: posted audit record failed; message deleted best-effort, /anon disabled",
        );
        return { ok: false, reason: "audit_failed" };
      }

      return { ok: true };
    },
  };
}
