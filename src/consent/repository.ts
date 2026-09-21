import type { ConsentScope } from "./scopes.js";
import type { ConsentRecord } from "./types.js";

/**
 * Storage abstraction for the consent registry.
 *
 * Implementations MUST throw on read/write failure. `ConsentService` is
 * fail-closed — any storage exception is propagated to the caller as a
 * `service-unavailable` decision. Silent success on corruption or a
 * missing file is acceptable for `load()` (returning an empty list), but
 * `save()` failures must surface.
 */
export interface ConsentRepository {
  /** Load every persisted record. Missing/corrupt file => empty list. */
  load(): Promise<ConsentRecord[]>;
  /** Replace the persisted set with `records`. Atomic where possible. */
  save(records: ConsentRecord[]): Promise<void>;
  /** Add or replace a single `(subjectId, scope)` record. */
  upsert(record: ConsentRecord): Promise<void>;
  /**
   * Remove the active grant for `(subjectId, scope)`. Returns `true` when
   * the row was removed, `false` when it was already absent. Callers can
   * use the boolean to avoid emitting duplicate side-effects (events,
   * cascades) for no-op revokes.
   */
  remove(subjectId: string, scope: ConsentScope): Promise<boolean>;
  /** Remove every grant for `subjectId` regardless of scope. */
  clearSubject(subjectId: string): Promise<void>;
}
