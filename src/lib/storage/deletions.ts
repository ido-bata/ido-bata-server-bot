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
 * Without the key the ledger stays empty. That is a *weaker* guarantee, so
 * the operator is warned at runtime and the runbook states that old
 * backups must not be restored without it.
 */

import { createHmac } from "node:crypto";

import { STORAGE_KEYS } from "./keys.js";
import type { StorageDriver } from "./types.js";

/** Storage key of the ledger. It travels with the data into every backup. */
export const DELETION_LEDGER_KEY = STORAGE_KEYS.deletionLedger;

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
 * Digest a subject id with the ledger key. The key must be at least 16
 * bytes of entropy; shorter keys are rejected by the caller.
 */
export function digestSubjectId(subjectId: string, key: string): string {
  return createHmac("sha256", key).update(subjectId, "utf8").digest("hex");
}

/** Read the ledger. A missing or unreadable ledger reads as empty. */
export async function readDeletionLedger(driver: StorageDriver): Promise<DeletionLedger> {
  const raw = await driver.readText(DELETION_LEDGER_KEY);
  if (raw === null) {
    return { records: [], schemaVersion: 1 };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DeletionLedger>;
    if (!Array.isArray(parsed.records)) {
      return { records: [], schemaVersion: 1 };
    }
    return {
      records: parsed.records.filter(
        (record): record is DeletionRecord =>
          typeof record?.digest === "string" && typeof record?.at === "string",
      ),
      schemaVersion: 1,
    };
  } catch {
    return { records: [], schemaVersion: 1 };
  }
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
 * Append a deletion record. The ledger is rewritten atomically, so a
 * concurrent append can lose a record — the ledger is written from the
 * (rare) `/privacy delete` path and the operator can reconcile.
 */
export async function appendDeletionRecord(
  driver: StorageDriver,
  record: DeletionRecord,
): Promise<void> {
  const ledger = await readDeletionLedger(driver);
  if (ledger.records.some((entry) => entry.digest === record.digest)) {
    return;
  }
  await driver.write(
    DELETION_LEDGER_KEY,
    `${JSON.stringify({ records: [...ledger.records, record], schemaVersion: 1 }, null, 2)}\n`,
  );
}
