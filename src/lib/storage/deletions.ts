/**
 * Deletion ledger — the record that a subject's data was erased.
 *
 * A `/privacy delete` removes the user's records from the live stores. A
 * backup taken *before* that deletion still contains them, so restoring
 * such a backup would resurrect data the user asked to forget. The ledger
 * closes that hole: every completed deletion is recorded, and a restore
 * re-applies the recorded erasures to the restored objects.
 *
 * The ledger never stores the subject id in plaintext. It stores an
 * HMAC-SHA256 digest computed with `DELETION_LEDGER_KEY`, so the ledger
 * itself cannot be turned back into user ids by someone who reads the
 * backup (the same reasoning as the removed audit index key in ADR-0003,
 * with a secret key this time). The restore needs the same key to match a
 * restored subject against the ledger — keep it in the secret manager.
 *
 * Failure policy (ADR-0004 §6b):
 *
 * - **Concurrent appends** are serialised with a compare-and-swap, so two
 *   simultaneous deletions cannot lose one another's record.
 * - **A corrupt ledger is never read as "no deletions"**: the strict read
 *   reports `corrupt` and the restore refuses to continue. Silently
 *   treating a damaged ledger as empty would turn every recorded erasure
 *   into a resurrection risk.
 * - **A missing ledger key** means the erasure history cannot be
 *   matched. The restore refuses (fail closed) unless the operator
 *   overrides it explicitly.
 */

import { createHmac } from "node:crypto";

import { STORAGE_KEYS } from "./keys.js";
import type { StorageDriver } from "./types.js";

/** Storage key of the ledger. It travels with the data into every backup. */
export const DELETION_LEDGER_KEY = STORAGE_KEYS.deletionLedger;

/** How often a concurrent ledger append retries. */
const APPEND_ATTEMPTS = 5;

export type DeletionRecord = {
  /** HMAC-SHA256 digest of the deleted subject id. */
  digest: string;
  /** ISO timestamp of the deletion. */
  at: string;
  /**
   * `true` when every consumer deleted the subject's data. A record with
   * `complete: false` marks a partially failed deletion — the restore
   * still removes the subject, but the operator is warned.
   */
  complete: boolean;
};

export type DeletionLedger = {
  schemaVersion: 1;
  records: DeletionRecord[];
};

/**
 * The outcome of reading the ledger.
 *
 * `missing` and `corrupt` are different states and must not be conflated:
 * "no deletions ever happened" is a legitimate state, "the ledger is
 * damaged" is a failure that hides deletions.
 */
export type DeletionLedgerState =
  | { status: "ok"; ledger: DeletionLedger }
  | { status: "missing" }
  | { status: "corrupt"; error: string };

/**
 * Digest a subject id with the ledger key. The key must be at least 16
 * bytes of entropy; shorter keys are rejected by the caller.
 */
export function digestSubjectId(subjectId: string, key: string): string {
  return createHmac("sha256", key).update(subjectId, "utf8").digest("hex");
}

function parseLedger(raw: string): DeletionLedger | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const candidate = parsed as Partial<DeletionLedger>;
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.records)) {
    return null;
  }
  const records: DeletionRecord[] = [];
  for (const record of candidate.records) {
    if (
      typeof record !== "object" ||
      record === null ||
      typeof record.digest !== "string" ||
      typeof record.at !== "string" ||
      typeof record.complete !== "boolean"
    ) {
      return null;
    }
    records.push({ at: record.at, complete: record.complete, digest: record.digest });
  }
  return { records, schemaVersion: 1 };
}

/**
 * Read the ledger and distinguish "missing" from "corrupt".
 *
 * This is the read the restore path uses: a corrupt ledger must abort the
 * restore, never look like an empty one.
 */
export async function readDeletionLedgerState(driver: StorageDriver): Promise<DeletionLedgerState> {
  let raw: string | null;
  try {
    raw = await driver.readText(DELETION_LEDGER_KEY);
  } catch (error) {
    return {
      error: `the deletion ledger could not be read: ${error instanceof Error ? error.message : String(error)}`,
      status: "corrupt",
    };
  }
  if (raw === null) {
    return { status: "missing" };
  }
  const ledger = parseLedger(raw);
  if (!ledger) {
    return {
      error: `the deletion ledger at ${DELETION_LEDGER_KEY} is not readable; refusing to treat it as empty`,
      status: "corrupt",
    };
  }
  return { ledger, status: "ok" };
}

/**
 * Best-effort read. A corrupt ledger reads as empty — only for callers
 * that must not fail (e.g. showing the ledger's contents to an operator).
 * The restore path uses `readDeletionLedgerState` instead.
 */
export async function readDeletionLedger(driver: StorageDriver): Promise<DeletionLedger> {
  const state = await readDeletionLedgerState(driver);
  return state.status === "ok" ? state.ledger : { records: [], schemaVersion: 1 };
}

/**
 * Merge two ledgers. The ledger is append-only: a restore must never drop
 * a deletion record that the live store already knows about, otherwise an
 * old backup could roll the erasure history back.
 */
export function mergeDeletionLedgers(
  current: DeletionLedger,
  incoming: DeletionLedger,
): DeletionLedger {
  const byDigest = new Map<string, DeletionRecord>();
  for (const record of current.records) {
    byDigest.set(record.digest, record);
  }
  for (const record of incoming.records) {
    const existing = byDigest.get(record.digest);
    if (!existing || record.at > existing.at) {
      byDigest.set(record.digest, record);
    }
  }
  return {
    records: [...byDigest.values()].sort((left, right) => left.at.localeCompare(right.at)),
    schemaVersion: 1,
  };
}

/**
 * Append a deletion record.
 *
 * The append is a compare-and-swap against the version that was read, so
 * two concurrent deletions cannot overwrite one another: the loser retries
 * against the fresh ledger. A ledger that is corrupt aborts the append —
 * writing over a damaged ledger would hide the deletions it may still
 * contain.
 */
export async function appendDeletionRecord(
  driver: StorageDriver,
  record: DeletionRecord,
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt += 1) {
    const stored = await driver.readVersioned(DELETION_LEDGER_KEY);
    const current = stored ? parseLedger(new TextDecoder().decode(stored.data)) : null;
    if (stored && !current) {
      return {
        error: `the deletion ledger at ${DELETION_LEDGER_KEY} is corrupt; refusing to overwrite it`,
        ok: false,
      };
    }
    const ledger = current ?? { records: [], schemaVersion: 1 };
    if (ledger.records.some((entry) => entry.digest === record.digest)) {
      return { ok: true };
    }
    const next: DeletionLedger = {
      records: [...ledger.records, record],
      schemaVersion: 1,
    };
    const result = await driver.compareAndSwap(
      DELETION_LEDGER_KEY,
      `${JSON.stringify(next, null, 2)}\n`,
      stored?.version ?? null,
    );
    if (result === "written") {
      return { ok: true };
    }
    if (result === "unsupported") {
      return {
        error:
          "the storage backend cannot perform conditional writes; the deletion ledger cannot be updated safely",
        ok: false,
      };
    }
    // "conflict": another writer appended first — retry against the new
    // version.
  }
  return {
    error: `the deletion ledger could not be updated after ${APPEND_ATTEMPTS} attempts`,
    ok: false,
  };
}
