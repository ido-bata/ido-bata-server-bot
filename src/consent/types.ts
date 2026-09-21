import type { ConsentScope } from "./scopes.js";

/**
 * Where a consent decision was sourced from — currently a Discord message
 * reaction. Persisted on each `ConsentRecord` so the audit trail can answer
 * "which message did this user react to in order to grant consent?".
 */
export type ConsentSource = {
  guildId: string;
  channelId: string;
  messageId: string;
  emoji: string;
};

/**
 * A single (subject, scope) grant. Multiple scopes for the same subject live
 * as separate records so each grant can be revoked independently.
 */
export type ConsentRecord = {
  subjectId: string;
  scope: ConsentScope;
  policyVersion: string;
  /** ISO 8601 timestamp when the grant was created. */
  grantedAt: string;
  /** ISO 8601 timestamp when the grant was revoked. `null` while active. */
  revokedAt: string | null;
  source: ConsentSource;
};

/**
 * Discriminated union for subscribers of `ConsentService`. The service
 * emits exactly one of these per state-changing operation.
 */
export type ConsentEvent =
  | { kind: "grant"; subjectId: string; scope: ConsentScope; at: string; source: ConsentSource }
  | { kind: "revoke"; subjectId: string; scope: ConsentScope; at: string }
  | { kind: "clear"; subjectId: string; at: string };

/**
 * Reaction target used by the reconciler + reaction handler. Mirrors the
 * `ConsentSource` shape but is a separate type so call sites that only need
 * to point at a message (without persistence) can use it without an
 * existing `ConsentRecord`.
 */
export type ReactionTarget = {
  guildId: string;
  channelId: string;
  messageId: string;
  emoji: string;
};

/**
 * Result of a `ConsentService.reconcile` pass. Discord API failures are
 * reported on the `failures` array; the service MUST NOT auto-grant when
 * the reaction fetch fails — operators are expected to retry.
 */
export type ReconcileReport = {
  appliedGrants: Array<{ subjectId: string; scope: ConsentScope }>;
  appliedRevokes: Array<{ subjectId: string; scope: ConsentScope }>;
  /** Discord guild ids whose reaction fetch failed. No auto-grant was issued. */
  failures: string[];
};

/**
 * Result of `ConsentService.clear(subjectId)`. Per-scope `ok: false`
 * entries do NOT mark the overall clear as successful — consumers can
 * inspect `results` to surface a partial-failure summary.
 */
export type ClearReport = {
  results: Array<{ scope: ConsentScope; ok: boolean; error?: string }>;
};
