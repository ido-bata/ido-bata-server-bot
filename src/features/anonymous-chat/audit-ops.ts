/**
 * Privacy-safe operation log for offline `/anon` audit custodian
 * tools (ADR-0003 §3, Issue #118).
 *
 * Appends one JSON line per operation phase to
 * `<audit-dir>/operations.jsonl`:
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
 * fsyncs the file (and the directory entry) before resolving, so an
 * acknowledged record survives a crash or power loss.
 */
import { chmod, open } from "node:fs/promises";
import { join } from "node:path";

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
): Promise<void> {
  const path = join(dir, "operations.jsonl");
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
  // The record must be DURABLE before the caller proceeds: write via
  // a FileHandle and fsync before resolving. `mode: 0o600` applies
  // only when the file is created.
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(line, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  // Enforce 0600 in case the file pre-existed with looser perms.
  await chmod(path, 0o600).catch(() => {});
  // fsync the directory so a newly created file's directory entry is
  // durable too. Cheap at custodian-tool frequencies.
  const dirHandle = await open(dir, "r");
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}
