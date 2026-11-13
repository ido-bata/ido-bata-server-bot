/**
 * Per-consumer delete adapter for the `/anon` audit log.
 *
 * Removes every `data/anon-audit/*.jsonl` record whose HMAC lookup
 * index matches the subject. The records themselves are RSA-OAEP
 * ciphertext — this adapter never decrypts; it only needs the bot-held
 * `ANON_AUDIT_INDEX_KEY` to compute the same index the writer used.
 *
 * Fail-closed semantics: if audit files exist but the index key is not
 * configured, the result is `ok:false` — claiming success would mean
 * `/privacy delete` reported deletion that never happened.
 */
import { join } from "node:path";

import { deleteAnonAuditRecords } from "../../anonymous-chat/audit-store.js";
import type { DeleteResult } from "../types.js";

export type AnonAuditDeleteOptions = {
  dir?: string;
  indexKey?: string;
};

const DEFAULT_DIR = join(process.cwd(), "data", "anon-audit");

export async function deleteUserData(
  userId: string,
  options: AnonAuditDeleteOptions = {},
): Promise<DeleteResult> {
  const dir = options.dir ?? process.env.ANON_AUDIT_DIR ?? DEFAULT_DIR;
  const indexKey = options.indexKey ?? process.env.ANON_AUDIT_INDEX_KEY;

  const result = await deleteAnonAuditRecords({ dir, indexKey, userId });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true };
}
