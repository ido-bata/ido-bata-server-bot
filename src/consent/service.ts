import type { ConsentScope } from "./scopes.js";
import { type ConsentLogger, createConsentLogger } from "./logger.js";
import type { ConsentRepository } from "./repository.js";
import {
  type ClearReport,
  type ConsentEvent,
  type ConsentRecord,
  type ConsentSource,
  type ReactionTarget,
  type ReconcileReport,
} from "./types.js";

/**
 * Result of an `authorize` check. Consumers must treat `ok: false` as
 * "do not access the data" — there is no implicit allow. The three
 * distinct failure modes let callers render different UX (retry vs.
 * re-request consent vs. contact operator).
 */
export type ConsentDecision =
  | { ok: true; policyVersion: string; grantedAt: string; source: ConsentSource }
  | { ok: false; reason: "no-grant" | "wrong-policy" | "service-unavailable" };

export type ScopeDeleteResult = { ok: boolean; error?: string };
export type ScopeDeleteFn = (
  subjectId: string,
  scope: ConsentScope,
) => Promise<ScopeDeleteResult>;

export type ReactionFetcher = {
  /**
   * Return the set of user ids that have reacted with `target.emoji` on
   * the message. Must throw on Discord API failure so the service can
   * route it to `ReconcileReport.failures`.
   */
  fetchMessageReactions(target: ReactionTarget): Promise<Set<string>>;
};

/**
 * Inputs for `createConsentService`. The repository is mandatory; pass a
 * stub that throws to exercise the fail-closed path in tests.
 */
export type ConsentServiceOptions = {
  repository: ConsentRepository;
  /** Discord reaction fetcher. Required if you intend to call `reconcile`. */
  fetcher?: ReactionFetcher;
  logger?: ConsentLogger;
  /** Wall-clock seam for tests. */
  now?: () => Date;
  /**
   * Policy version the service treats as "current". Grants stored with a
   * different version are treated as stale and `authorize` returns
   * `wrong-policy` for them.
   */
  policyVersion: string;
  /**
   * Map an emoji (as it appears on the consent message) to its scope.
   * Used by `reconcile` to know which `ConsentScope` each
   * `ReactionTarget` represents. The reaction handler consults the same
   * mapping so both stay in lock-step.
   */
  emojiToScope: ReadonlyMap<string, ConsentScope>;
  /**
   * The bot's own user id. Required for `reconcile` so the bot's own
   * reactions don't self-grant. Operators can also configure the
   * fetcher to filter them out — both layers are belt-and-suspenders.
   */
  botUserId?: string;
};

export type GrantInput = {
  subjectId: string;
  scope: ConsentScope;
  source: ConsentSource;
};

export interface ConsentService {
  /** Decide whether a subject may be processed for `scope`. Fail-closed. */
  authorize(subjectId: string, scope: ConsentScope): Promise<ConsentDecision>;
  /**
   * Reconcile grants against the Discord reaction set. Fail-closed on
   * Discord API failure (no auto-grant). Requires `fetcher` to be
   * supplied at construction time.
   */
  reconcile(targets: ReadonlyArray<ReactionTarget>): Promise<ReconcileReport>;
  /** Return all currently-active grants for `subjectId`. */
  list(subjectId: string): Promise<ConsentRecord[]>;
  /** Remove every grant for `subjectId` and cascade to per-scope delete fns. */
  clear(subjectId: string, deleteFn?: ScopeDeleteFn): Promise<ClearReport>;
  /** Subscribe to consent events. Returns an unsubscribe function. */
  subscribe(listener: (event: ConsentEvent) => void): () => void;
  /** Add or refresh a grant. Emits a `grant` event. */
  grant(input: GrantInput): Promise<ConsentRecord>;
  /** Revoke an active grant. Emits a `revoke` event (no-op if absent). */
  revoke(subjectId: string, scope: ConsentScope): Promise<void>;
}

function isActive(record: ConsentRecord): boolean {
  return record.revokedAt === null;
}

export function createConsentService(options: ConsentServiceOptions): ConsentService {
  const repository = options.repository;
  const fetcher = options.fetcher ?? null;
  const logger = (options.logger ?? createConsentLogger({ enabled: false })).child({
    module: "consent-service",
  });
  const now = options.now ?? (() => new Date());
  const policyVersion = options.policyVersion;
  const emojiToScope = options.emojiToScope;
  const botUserId = options.botUserId ?? "";

  const listeners = new Set<(event: ConsentEvent) => void>();

  function emit(event: ConsentEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        logger.warn("consent event listener threw", { error: stringifyError(error) });
      }
    }
  }

  async function loadAll(): Promise<ConsentRecord[]> {
    return repository.load();
  }

  async function authorize(
    subjectId: string,
    scope: ConsentScope,
  ): Promise<ConsentDecision> {
    let records: ConsentRecord[];
    try {
      records = await loadAll();
    } catch (error) {
      logger.error("authorize: repository load failed", { error: stringifyError(error) });
      return { ok: false, reason: "service-unavailable" };
    }

    const match = records.find(
      (record) => record.subjectId === subjectId && record.scope === scope && isActive(record),
    );
    if (!match) {
      return { ok: false, reason: "no-grant" };
    }
    if (match.policyVersion !== policyVersion) {
      return { ok: false, reason: "wrong-policy" };
    }
    return {
      ok: true,
      policyVersion: match.policyVersion,
      grantedAt: match.grantedAt,
      source: match.source,
    };
  }

  async function grant(input: GrantInput): Promise<ConsentRecord> {
    const at = now().toISOString();
    const record: ConsentRecord = {
      subjectId: input.subjectId,
      scope: input.scope,
      policyVersion,
      grantedAt: at,
      revokedAt: null,
      source: input.source,
    };
    try {
      await repository.upsert(record);
    } catch (error) {
      logger.error("grant: repository upsert failed", { error: stringifyError(error) });
      throw error;
    }
    emit({
      kind: "grant",
      subjectId: record.subjectId,
      scope: record.scope,
      at,
      source: record.source,
    });
    return record;
  }

  async function revoke(subjectId: string, scope: ConsentScope): Promise<void> {
    let records: ConsentRecord[];
    try {
      records = await loadAll();
    } catch (error) {
      logger.error("revoke: repository load failed", { error: stringifyError(error) });
      throw error;
    }
    const match = records.find(
      (record) => record.subjectId === subjectId && record.scope === scope && isActive(record),
    );
    if (!match) {
      return;
    }
    const at = now().toISOString();
    try {
      await repository.remove(subjectId, scope);
    } catch (error) {
      logger.error("revoke: repository remove failed", { error: stringifyError(error) });
      throw error;
    }
    emit({ kind: "revoke", subjectId, scope, at });
  }

  async function list(subjectId: string): Promise<ConsentRecord[]> {
    const records = await loadAll();
    return records.filter((record) => record.subjectId === subjectId && isActive(record));
  }

  async function clear(subjectId: string, deleteFn?: ScopeDeleteFn): Promise<ClearReport> {
    let records: ConsentRecord[];
    try {
      records = await loadAll();
    } catch (error) {
      logger.error("clear: repository load failed", { error: stringifyError(error) });
      throw error;
    }
    const subjectsRecords = records.filter(
      (record) => record.subjectId === subjectId && isActive(record),
    );

    const results: ClearReport["results"] = [];
    for (const record of subjectsRecords) {
      let ok = true;
      let error: string | undefined;
      if (deleteFn) {
        try {
          const result = await deleteFn(subjectId, record.scope);
          ok = result.ok;
          error = result.error;
        } catch (caught) {
          ok = false;
          error = stringifyError(caught);
        }
      }
      if (ok) {
        try {
          await repository.remove(subjectId, record.scope);
        } catch (caught) {
          ok = false;
          error = stringifyError(caught);
        }
      }
      results.push({ scope: record.scope, ok, error });
    }

    if (results.some((result) => result.ok)) {
      const at = now().toISOString();
      emit({ kind: "clear", subjectId, at });
    }

    return { results };
  }

  function resolveScope(emoji: string): ConsentScope | null {
    return emojiToScope.get(emoji) ?? null;
  }

  async function reconcile(
    targets: ReadonlyArray<ReactionTarget>,
  ): Promise<ReconcileReport> {
    const report: ReconcileReport = {
      appliedGrants: [],
      appliedRevokes: [],
      failures: [],
    };

    if (!fetcher) {
      logger.error("reconcile: no fetcher configured");
      for (const target of targets) {
        if (!report.failures.includes(target.guildId)) {
          report.failures.push(target.guildId);
        }
      }
      return report;
    }

    const grouped = new Map<string, ReactionTarget[]>();
    for (const target of targets) {
      const key = `${target.guildId}:${target.channelId}:${target.messageId}`;
      const bucket = grouped.get(key) ?? [];
      bucket.push(target);
      grouped.set(key, bucket);
    }

    for (const [, bucket] of grouped) {
      // Fetch each emoji separately so the fetcher can ask Discord for a
      // single emoji at a time. We deliberately do NOT short-circuit on
      // a single failure — the report carries `failures[]` so operators
      // can see which guilds were skipped.
      for (const target of bucket) {
        const scope = resolveScope(target.emoji);
        if (!scope) {
          // Emoji is not registered for consent. Treat as a config bug
          // (operators forgot to wire an emoji), surface it on the
          // failures list so it does not silently grant.
          logger.warn("reconcile: emoji not mapped to scope", {
            emoji: target.emoji,
            guildId: target.guildId,
          });
          report.failures.push(target.guildId);
          continue;
        }

        let records: ConsentRecord[];
        try {
          records = await loadAll();
        } catch (error) {
          logger.error("reconcile: repository load failed", {
            error: stringifyError(error),
          });
          report.failures.push(target.guildId);
          continue;
        }

        const active = records.filter(
          (record) =>
            record.source.guildId === target.guildId &&
            record.source.channelId === target.channelId &&
            record.source.messageId === target.messageId &&
            record.source.emoji === target.emoji &&
            isActive(record),
        );

        const grantedNow = new Set<string>();
        try {
          const reactors = await fetcher.fetchMessageReactions(target);
          for (const userId of reactors) {
            if (userId === botUserId) {
              continue;
            }
            const existing = active.find((record) => record.subjectId === userId);
            if (existing) {
              grantedNow.add(userId);
              continue;
            }
            try {
              await grant({
                subjectId: userId,
                scope,
                source: {
                  guildId: target.guildId,
                  channelId: target.channelId,
                  messageId: target.messageId,
                  emoji: target.emoji,
                },
              });
              report.appliedGrants.push({ subjectId: userId, scope });
              grantedNow.add(userId);
            } catch (error) {
              logger.error("reconcile: grant failed", {
                error: stringifyError(error),
                userId,
                scope,
              });
              report.failures.push(target.guildId);
            }
          }
        } catch (error) {
          logger.error("reconcile: discord fetch failed", {
            error: stringifyError(error),
            guildId: target.guildId,
            emoji: target.emoji,
          });
          report.failures.push(target.guildId);
          continue;
        }

        for (const record of active) {
          if (!grantedNow.has(record.subjectId)) {
            try {
              await revoke(record.subjectId, record.scope);
              report.appliedRevokes.push({
                subjectId: record.subjectId,
                scope: record.scope,
              });
            } catch (error) {
              logger.error("reconcile: revoke failed", {
                error: stringifyError(error),
                userId: record.subjectId,
              });
              report.failures.push(target.guildId);
            }
          }
        }
      }
    }

    return report;
  }

  function subscribe(listener: (event: ConsentEvent) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return {
    authorize,
    reconcile,
    list,
    clear,
    subscribe,
    grant,
    revoke,
  };
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}