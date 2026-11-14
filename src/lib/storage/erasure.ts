/**
 * Re-apply recorded erasures to restored objects.
 *
 * The deletion ledger (`src/lib/storage/deletions.ts`) records that a
 * subject's data was erased. A backup taken before that erasure still
 * contains the subject, so a restore must remove it again — otherwise the
 * restore silently resurrects data the user asked to forget.
 *
 * The ledger stores HMAC digests, so the restore matches a restored
 * subject by digesting its id with the same key. Without the key the
 * ledger cannot be applied; the caller must then refuse to restore old
 * backups (see `docs/operations/altare-migration.md`).
 */

import { digestSubjectId, readDeletionLedger } from "./deletions.js";
import type { StorageDriver } from "./types.js";

export type ErasureReport = {
  /** Subjects whose records were removed from the restored objects. */
  removedSubjects: string[];
  /** Ledger entries that marked a partially failed deletion. */
  incompleteDeletions: number;
  /** Objects that were rewritten because a subject was removed. */
  rewrittenObjects: string[];
};

/** The stores that hold user-keyed records and are therefore filtered. */
const FILTERED_OBJECTS = [
  "consent.json",
  "timekeeper-history.json",
  "birthdays.json",
  "polls.json",
  "reminders.json",
] as const;

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Read a string field from an unknown record without asserting its shape. */
function stringField(value: unknown, field: string): string | null {
  const record = asRecord(value);
  if (!record || !(field in record)) {
    return null;
  }
  const fieldValue = record[field];
  return typeof fieldValue === "string" ? fieldValue : null;
}

/** Read a nested record field (e.g. `votes`) from an unknown record. */
function recordField(value: unknown, field: string): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record || !(field in record)) {
    return null;
  }
  return asRecord(record[field]);
}

function removeSubjectFromStore(
  value: unknown,
  subjectId: string,
): { changed: boolean; value: unknown } {
  const store = asRecord(value);
  if (!store) {
    return { changed: false, value };
  }

  // consent.json: `{ schemaVersion, records: [{ subjectId, … }] }`
  if (Array.isArray(store.records)) {
    const records = store.records.filter(
      (record) => stringField(record, "subjectId") !== subjectId,
    );
    if (records.length === store.records.length) {
      return { changed: false, value };
    }
    return { changed: true, value: { ...store, records } };
  }

  // birthdays.json: `{ birthdays: { [userId]: entry } }`
  const birthdays = asRecord(store.birthdays);
  if (birthdays) {
    if (!(subjectId in birthdays)) {
      return { changed: false, value };
    }
    const next = { ...birthdays };
    delete next[subjectId];
    return { changed: true, value: { ...store, birthdays: next } };
  }

  // polls.json: `{ version, polls: [{ creatorId, votes }] }`
  if (Array.isArray(store.polls)) {
    let changed = false;
    const polls = store.polls.map((poll) => {
      const record = asRecord(poll);
      if (!record) {
        return poll;
      }
      let next: Record<string, unknown> = record;
      if (stringField(poll, "creatorId") === subjectId) {
        next = { ...record, votes: {} };
        changed = true;
      }
      const votes = asRecord(record.votes);
      if (votes && subjectId in votes) {
        const nextVotes = { ...votes };
        delete nextVotes[subjectId];
        next = { ...next, votes: nextVotes };
        changed = true;
      }
      return next;
    });
    if (!changed) {
      return { changed: false, value };
    }
    return { changed: true, value: { ...store, polls } };
  }

  // timekeeper-history.json / reminders.json: flat maps keyed by user id
  if (subjectId in store) {
    const next = { ...store };
    delete next[subjectId];
    return { changed: true, value: next };
  }

  return { changed: false, value };
}

/**
 * Collect the subject ids that appear in a store.
 *
 * Used both by the restore (to find the ids to erase) and by the
 * verification (to compute the *expected* final state after the erasure
 * was re-applied).
 */
export function collectSubjectIds(value: unknown, into: Set<string>): Set<string> {
  const store = asRecord(value);
  if (!store) {
    return into;
  }
  for (const field of Object.keys(store)) {
    // A flat map (timekeeper-history.json, reminders.json) stores the
    // subject id as the *key of the store itself*.
    into.add(field);
    const nested = asRecord(store[field]);
    if (!nested) {
      continue;
    }
    for (const id of Object.keys(nested)) {
      into.add(id);
    }
  }
  if (Array.isArray(store.records)) {
    for (const record of store.records) {
      const subjectId = stringField(record, "subjectId");
      if (subjectId) {
        into.add(subjectId);
      }
    }
  }
  if (Array.isArray(store.polls)) {
    for (const poll of store.polls) {
      const creatorId = stringField(poll, "creatorId");
      if (creatorId) {
        into.add(creatorId);
      }
      const votes = recordField(poll, "votes");
      for (const voter of votes ? Object.keys(votes) : []) {
        into.add(voter);
      }
    }
  }
  return into;
}

/**
 * The state an object must have after the recorded erasures were applied.
 *
 * The verification compares the restored store against this value, so a
 * correct post-erasure state is recognised as correct instead of being
 * reported as a checksum mismatch.
 */
export function applyErasuresToValue(
  value: unknown,
  subjectIds: readonly string[],
): { changed: boolean; value: unknown } {
  let current = value;
  let changed = false;
  for (const subjectId of subjectIds) {
    const outcome = removeSubjectFromStore(current, subjectId);
    current = outcome.value;
    changed = changed || outcome.changed;
  }
  return { changed, value: current };
}

/**
 * Remove every subject recorded in the ledger from the restored objects.
 *
 * The subject ids are recovered by scanning the restored objects for the
 * subject ids they contain and matching their digest against the ledger —
 * the ledger itself never holds a plaintext id.
 */
export async function applyDeletionLedger(
  driver: StorageDriver,
  ledgerKey: string,
): Promise<ErasureReport> {
  const report: ErasureReport = {
    incompleteDeletions: 0,
    removedSubjects: [],
    rewrittenObjects: [],
  };
  if (!ledgerKey) {
    return report;
  }

  const ledger = await readDeletionLedger(driver);
  if (ledger.records.length === 0) {
    return report;
  }
  const digests = new Set(ledger.records.map((record) => record.digest));
  report.incompleteDeletions = ledger.records.filter((record) => !record.complete).length;

  // Collect the subject ids that appear in the restored objects.
  const candidates = new Set<string>();
  for (const key of FILTERED_OBJECTS) {
    const raw = await driver.readText(key);
    if (raw === null) {
      continue;
    }
    collectSubjectIds(parseJson(raw), candidates);
  }

  const deletedSubjects = [...candidates].filter((candidate) =>
    digests.has(digestSubjectId(candidate, ledgerKey)),
  );
  if (deletedSubjects.length === 0) {
    return report;
  }

  for (const key of FILTERED_OBJECTS) {
    const raw = await driver.readText(key);
    if (raw === null) {
      continue;
    }
    let current: unknown = parseJson(raw);
    let changed = false;
    for (const subjectId of deletedSubjects) {
      const outcome = removeSubjectFromStore(current, subjectId);
      current = outcome.value;
      changed = changed || outcome.changed;
    }
    if (changed) {
      await driver.write(key, `${JSON.stringify(current, null, 2)}\n`);
      report.rewrittenObjects.push(key);
    }
  }

  report.removedSubjects = deletedSubjects;
  return report;
}
