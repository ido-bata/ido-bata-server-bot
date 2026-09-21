import { type ConsentLogger, createConsentLogger } from "./logger.js";
import type { ConsentRepository } from "./repository.js";
import type { ConsentScope } from "./scopes.js";
import type {
  ClearReport,
  ConsentEvent,
  ConsentRecord,
  ConsentSource,
  ReactionTarget,
  ReconcileReport,
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
export type ScopeDeleteFn = (subjectId: string, scope: ConsentScope) => Promise<ScopeDeleteResult>;

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

  // In-memory snapshot cache. `authorize()` is on the hot path (every
  // privacy-gated consumer hits it) and the previous implementation did a
  // full `repository.load()` (readFileSync + Zod parse of the entire
  // record set) on every call. We invalidate the cache whenever any
  // mutation function runs so the snapshot stays consistent.
  let cache: ConsentRecord[] | null = null;

  function invalidate(): void {
    cache = null;
  }

  async function loadAll(): Promise<ConsentRecord[]> {
    if (cache === null) {
      cache = await repository.load();
    }
    return cache;
  }

  function emit(event: ConsentEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        logger.warn("consent event listener threw", { error: stringifyError(error) });
      }
    }
  }

  async function authorize(subjectId: string, scope: ConsentScope): Promise<ConsentDecision> {
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
    invalidate();
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
    // Let `repository.remove()` be the single source of truth: it reports
    // whether the row was present so we do not emit a phantom `revoke`
    // event for an already-revoked scope (the previous pre-load had a
    // TOCTOU race that allowed two concurrent revokes to double-emit).
    let removed: boolean;
    try {
      removed = await repository.remove(subjectId, scope);
    } catch (error) {
      logger.error("revoke: repository remove failed", { error: stringifyError(error) });
      throw error;
    }
    if (!removed) {
      return;
    }
    invalidate();
    const at = now().toISOString();
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
      invalidate();
      const at = now().toISOString();
      emit({ kind: "clear", subjectId, at });
    }

    return { results };
  }

  function resolveScope(emoji: string): ConsentScope | null {
    return emojiToScope.get(emoji) ?? null;
  }

  async function reconcile(targets: ReadonlyArray<ReactionTarget>): Promise<ReconcileReport> {
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

    // Single load at the top of `reconcile()`. Subsequent `save()` calls
    // are full-file replacements built from this snapshot, so we do not
    // need to re-read between emojis. The cache from `loadAll()` already
    // avoids re-reading the file across multiple emoji buckets, but we
    // snapshot once here too so the in-memory mutation pass doesn't fight
    // the cache's lazy-load semantics.
    let snapshot: ConsentRecord[];
    try {
      snapshot = await loadAll();
    } catch (error) {
      logger.error("reconcile: repository load failed", {
        error: stringifyError(error),
      });
      for (const target of targets) {
        if (!report.failures.includes(target.guildId)) {
          report.failures.push(target.guildId);
        }
      }
      return report;
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

        const active = snapshot.filter(
          (record) =>
            record.source.guildId === target.guildId &&
            record.source.channelId === target.channelId &&
            record.source.messageId === target.messageId &&
            record.source.emoji === target.emoji &&
            isActive(record),
        );

        let reactors: Set<string>;
        try {
          reactors = await fetcher.fetchMessageReactions(target);
        } catch (error) {
          logger.error("reconcile: discord fetch failed", {
            error: stringifyError(error),
            guildId: target.guildId,
            emoji: target.emoji,
          });
          report.failures.push(target.guildId);
          continue;
        }

        // Build the next state for this emoji in memory: keep reactors,
        // drop non-reactors. We never mutate `snapshot` directly — every
        // emoji gets its own working copy.
        const subjectToRecord = new Map<string, ConsentRecord>();
        for (const record of active) {
          subjectToRecord.set(record.subjectId, record);
        }

        const newRecords: ConsentRecord[] = [];
        const grantedNow = new Set<string>();
        // Per-emoji entries — flushed to `report` only after the save
        // succeeds, so subscribers never see "applied" events for a
        // mutation that ultimately failed and was rolled back.
        const newGrants: Array<{ subjectId: string; scope: ConsentScope }> = [];
        const newRevokes: Array<{ subjectId: string; scope: ConsentScope }> = [];
        const at = now().toISOString();

        for (const userId of reactors) {
          if (userId === botUserId) {
            continue;
          }
          const existing = subjectToRecord.get(userId);
          if (existing) {
            // Already an active grant — preserve the original grantedAt
            // so the persistence record matches what the operator saw
            // before reconcile.
            newRecords.push(existing);
            grantedNow.add(userId);
            continue;
          }
          const fresh: ConsentRecord = {
            subjectId: userId,
            scope,
            policyVersion,
            grantedAt: at,
            revokedAt: null,
            source: {
              guildId: target.guildId,
              channelId: target.channelId,
              messageId: target.messageId,
              emoji: target.emoji,
            },
          };
          newRecords.push(fresh);
          grantedNow.add(userId);
          newGrants.push({ subjectId: userId, scope });
        }

        // Diff revokes: records in `active` whose subject isn't in
        // `grantedNow`. We mark them as revoked rather than dropping
        // them — the audit log (`ConsentRecord.revokedAt`) keeps the
        // history of who was once granted and when.
        for (const record of active) {
          if (grantedNow.has(record.subjectId)) {
            continue;
          }
          newRecords.push({ ...record, revokedAt: at });
          newRevokes.push({ subjectId: record.subjectId, scope: record.scope });
        }

        // Reassemble the full snapshot: drop the active rows for this
        // emoji (we just rebuilt them in `newRecords`), keep everything
        // else verbatim. A single `save()` replaces the whole file.
        const nextSnapshot: ConsentRecord[] = [
          ...snapshot.filter(
            (record) =>
              !(
                record.source.guildId === target.guildId &&
                record.source.channelId === target.channelId &&
                record.source.messageId === target.messageId &&
                record.source.emoji === target.emoji
              ),
          ),
          ...newRecords,
        ];

        try {
          await repository.save(nextSnapshot);
        } catch (error) {
          logger.error("reconcile: repository save failed", {
            error: stringifyError(error),
            guildId: target.guildId,
            emoji: target.emoji,
          });
          report.failures.push(target.guildId);
          continue;
        }

        // Commit the new snapshot so the next emoji sees our writes
        // and `authorize()` callers (after we return) see them too.
        snapshot = nextSnapshot;
        invalidate();

        // Publish to the report + emit events for downstream subscribers
        // (audit log, cascade deletes, etc.) — only after the save
        // succeeded.
        for (const entry of newGrants) {
          report.appliedGrants.push(entry);
          emit({
            kind: "grant",
            subjectId: entry.subjectId,
            scope: entry.scope,
            at,
            source: {
              guildId: target.guildId,
              channelId: target.channelId,
              messageId: target.messageId,
              emoji: target.emoji,
            },
          });
        }
        for (const entry of newRevokes) {
          report.appliedRevokes.push(entry);
          emit({ kind: "revoke", subjectId: entry.subjectId, scope: entry.scope, at });
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
