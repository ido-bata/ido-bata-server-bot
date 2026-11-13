/**
 * `/anon` posting service (ADR-0003).
 *
 * Pipeline per invocation:
 *   validate → deny-list → cooldown → channel/guild/member resolution →
 *   effective permissions (user + bot) → thread state → consent →
 *   seal audit payload → post → append audit (rollback-delete on
 *   failure).
 *
 * Anonymity rules enforced here:
 *   - No user id, message body, or interaction object is ever logged.
 *   - Audit mode seals the author mapping BEFORE posting; a sealing
 *     failure rejects the post (fail closed, no plaintext fallback).
 *   - An audit-append failure after a successful post deletes the
 *     message — an anonymous post must never exist unaccounted for.
 */

import { PermissionFlagsBits } from "discord.js";
import type { AnonAuditSink } from "./audit-store.js";
import { createAnonAuditSink } from "./audit-store.js";
import type { AnonymousChatConfig } from "./config.js";
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
  now?: () => number;
  logger?: AnonLogger;
};

export type AnonymousChatService = {
  post: (input: AnonPostInput) => Promise<AnonPostResult>;
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
  if (!isPrivateThread(channel)) {
    return true;
  }
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

  // Build the audit sink once. An invalid key disables audit loudly —
  // never falls back to plaintext or to posting without the mapping
  // the operator asked for... except that audit-off is the documented
  // ephemeral mode, so disabling here matches "key not deployed".
  let audit = deps.audit;
  if (audit === undefined && config.audit) {
    try {
      audit = createAnonAuditSink(config.audit);
      // Best-effort retention sweep at startup; failures are logged, not
      // fatal — the next append sweeps again.
      void audit.sweep().catch((error: unknown) => {
        logger?.warn({ err: error }, "anonymous-chat: audit retention sweep failed");
      });
    } catch (error) {
      logger?.error(
        { err: error },
        "anonymous-chat: failed to initialize audit sink; audit persistence disabled",
      );
      audit = null;
    }
  } else if (audit) {
    void audit.sweep().catch((error: unknown) => {
      logger?.warn({ err: error }, "anonymous-chat: audit retention sweep failed");
    });
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
      logger?.warn({ err: error }, "anonymous-chat: permission resolution failed");
      return null;
    }
  }

  return {
    async post(input) {
      const text = input.message.trim();
      if (text.length === 0 || text.length > config.maxMessageLength) {
        return { ok: false, reason: "invalid_message" };
      }
      if (config.denyChannelIds.has(input.channelId)) {
        return { ok: false, reason: "denied" };
      }

      const retryAfterMs = cooldown.hit(input.userId);
      if (retryAfterMs > 0) {
        return { ok: false, reason: "cooldown", retryAfterMs };
      }

      let channel: AnonChannelLike | null;
      try {
        channel = await deps.fetchChannel(input.channelId);
      } catch (error) {
        logger?.warn({ err: error }, "anonymous-chat: channel fetch failed");
        return { ok: false, reason: "denied" };
      }
      if (!channel || channel.guildId !== input.guildId || !isSupportedChannel(channel)) {
        return { ok: false, reason: "denied" };
      }

      if (isThreadChannel(channel)) {
        if (channel.locked === true) {
          return { ok: false, reason: "denied" };
        }
        if (!(await isThreadMemberSafe(channel, input.userId, deps))) {
          return { ok: false, reason: "denied" };
        }
      }

      let guild: AnonGuildLike | null;
      try {
        guild = await deps.fetchGuild(input.guildId);
      } catch (error) {
        logger?.warn({ err: error }, "anonymous-chat: guild fetch failed");
        return { ok: false, reason: "denied" };
      }
      if (!guild) {
        return { ok: false, reason: "denied" };
      }

      let member: AnonMemberLike | null;
      try {
        member = await deps.fetchMember(guild, input.userId);
      } catch (error) {
        logger?.warn({ err: error }, "anonymous-chat: member fetch failed");
        return { ok: false, reason: "denied" };
      }
      if (!member) {
        return { ok: false, reason: "denied" };
      }

      const userPermissions = await resolveMemberPermissions(channel, member, guild);
      if (!userPermissions || !canPostWith(channel, userPermissions)) {
        return { ok: false, reason: "denied" };
      }

      let botMember: AnonMemberLike | null;
      try {
        botMember = await deps.fetchBotMember(guild);
      } catch (error) {
        logger?.warn({ err: error }, "anonymous-chat: bot member fetch failed");
        return { ok: false, reason: "denied" };
      }
      if (!botMember) {
        return { ok: false, reason: "denied" };
      }
      const botPermissions = await resolveMemberPermissions(channel, botMember, guild);
      const sendBit = requiredSendBit(channel);
      if (
        !botPermissions ||
        !botPermissions.has(PermissionFlagsBits.ViewChannel) ||
        !botPermissions.has(sendBit)
      ) {
        return { ok: false, reason: "bot_permission_denied" };
      }

      // ---- audit pre-flight (fail closed before any public post) ----
      let sealedPayload: string | null = null;
      if (audit) {
        let consentOk = true;
        if (deps.authorizeAudit) {
          try {
            consentOk = await deps.authorizeAudit(input.userId);
          } catch {
            consentOk = false;
          }
        }
        if (!consentOk) {
          logger?.warn({}, "anonymous-chat: audit consent denied");
          return { ok: false, reason: "unavailable" };
        }
        try {
          sealedPayload = audit.seal({
            userId: input.userId,
            guildId: input.guildId,
            channelId: input.channelId,
            postedAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
          });
        } catch (error) {
          // Never fall back to plaintext or to an unlogged post.
          logger?.error({ err: error }, "anonymous-chat: audit seal failed; post rejected");
          return { ok: false, reason: "unavailable" };
        }
      }

      // ---- public post ----
      let sent: { id: string; delete: () => Promise<unknown> };
      try {
        sent = await channel.send({
          content: text,
          allowedMentions: { parse: [] },
        });
      } catch (error) {
        logger?.warn({ err: error }, "anonymous-chat: channel send failed");
        return { ok: false, reason: "post_failed" };
      }

      // ---- audit append (rollback on failure) ----
      if (audit && sealedPayload) {
        try {
          await audit.record({
            userId: input.userId,
            guildId: input.guildId,
            channelId: input.channelId,
            messageId: sent.id,
            postedAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
            ciphertext: sealedPayload,
          });
        } catch (error) {
          logger?.error(
            { err: error },
            "anonymous-chat: audit append failed; deleting posted message",
          );
          try {
            await sent.delete();
          } catch (deleteError) {
            logger?.error(
              { err: deleteError },
              "anonymous-chat: rollback delete failed; unlogged anonymous post may remain",
            );
          }
          return { ok: false, reason: "audit_failed" };
        }
      }

      return { ok: true };
    },
  };
}
