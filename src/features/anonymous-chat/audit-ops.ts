/**
 * Privacy-safe operation log for offline `/anon` audit custodian
 * tools (ADR-0003 §3, Issue #118).
 *
 * Appends one JSON line per operation to `<audit-dir>/operations.jsonl`.
 * Entries contain ONLY operational metadata — timestamp, operation
 * name, record counts, number of keys tried. Query values (user ids,
 * message ids, attempt ids) and ciphertext are NEVER written here;
 * the custodian keeps the approval record (who/why/when) in their own
 * procedure outside the repo.
 *
 * `operations.jsonl` does not match the record-file pattern
 * (`YYYY-MM-DD*.jsonl` record files only), so the retention sweep, `hasAnonAuditRecords`,
 * and the delete/lookup scanners all ignore it.
 */
import { appendFile, chmod } from "node:fs/promises";
import { join } from "node:path";

export type AnonAuditOperation = {
  op: "lookup" | "delete";
  scanned: number;
  matched?: number;
  removed?: number;
  keys?: number;
};

export async function appendAnonAuditOperation(
  dir: string,
  entry: AnonAuditOperation,
): Promise<void> {
  const path = join(dir, "operations.jsonl");
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
  await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
  // appendFile's mode only applies at creation; enforce 0600 anyway in
  // case the file pre-existed with looser permissions.
  await chmod(path, 0o600).catch(() => {});
}
