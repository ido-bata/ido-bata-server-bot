/**
 * Privacy-safe operation log for offline `/anon` audit custodian
 * tools (ADR-0003 §3, Issue #118).
 *
 * Appends one JSON line per operation phase to
 * `<audit-prefix>/operations.jsonl`:
 *
 *   {"ts":"…","op":"lookup","phase":"start","keys":1}
 *   {"ts":"…","op":"lookup","phase":"end","scanned":42,"results":3}
 *   {"ts":"…","op":"delete","phase":"start","keys":1}
 *   {"ts":"…","op":"delete","phase":"end","scanned":42,"removed":1}
 *
 * Entries contain ONLY operational metadata — timestamp, operation
 * name, phase, record counts, number of keys tried. Query values
 * (user ids, message ids, attempt ids) and ciphertext are NEVER
 * written here; the custodian keeps the approval record (who/why/when)
 * in their own procedure outside the repo.
 *
 * `operations.jsonl` does not match the record-file pattern
 * (`YYYY-MM-DD*.jsonl` record files only), so the retention sweep,
 * `hasAnonAuditRecords`, and the delete/lookup scanners all ignore it.
 *
 * Failure contract: `appendAnonAuditOperation` THROWS on any failure.
 * Callers must treat a failed append as fatal for the sensitive part
 * of the operation — a lookup must withhold plaintext output and a
 * delete must not run — so no disclosure or deletion ever completes
 * without a durable operation record (Issue #118 review). The append
 * only resolves after the storage backend confirmed the new content
 * is durable, so an acknowledged record survives a crash or power
 * loss.
 */
import { getStorageDriver } from "../../lib/storage/index.js";
import { STORAGE_KEYS } from "../../lib/storage/keys.js";
import type { StorageDriver } from "../../lib/storage/types.js";
import { joinStorageKey } from "../../lib/storage/types.js";

export type AnonAuditOperation = {
  op: "lookup" | "delete";
  phase: "start" | "end";
  /** Records examined (end phase). */
  scanned?: number;
  /** Plaintext records disclosed to the custodian (lookup end). */
  results?: number;
  /** Records removed (delete end). */
  removed?: number;
  /** Private keys made available to the tool (start phase). */
  keys?: number;
};

export async function appendAnonAuditOperation(
  dir: string,
  entry: AnonAuditOperation,
  options: { driver?: StorageDriver } = {},
): Promise<void> {
  const driver = options.driver ?? getStorageDriver();
  const key = joinStorageKey(
    dir,
    STORAGE_KEYS.anonAuditOperations.split("/").pop() ?? "operations.jsonl",
  );
  const existing = await driver.readText(key);
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
  const body = existing === null ? line : `${existing}${line}`;
  await driver.write(key, body);
}
