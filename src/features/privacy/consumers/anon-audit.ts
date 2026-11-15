/**
 * Per-consumer delete adapter for the `/anon` audit log.
 *
 * Audit records are RSA-OAEP ciphertext with NO bot-computable
 * per-user index (ADR-0003 §3): any deterministic tag over a Discord
 * user id is dictionary-attackable over the public guild roster, so
 * the bot must not be able to re-identify authors — which also means
 * it cannot selectively delete one user's records.
 *
 * This adapter therefore reports honestly:
 *   - no audit files          → ok (nothing to delete)
 *   - audit files present     → ok:false explaining that deletion
 *     requires the offline key custodian (`bun run anon:audit:delete`)
 *
 * Claiming success here would tell `/privacy delete` callers their
 * data is gone when it is not — a privacy invariant violation.
 */

import { getStorageDriver } from "../../../lib/storage/index.js";
import type { StorageDriver } from "../../../lib/storage/types.js";
import { hasAnonAuditRecords } from "../../anonymous-chat/audit-store.js";
import { resolveAnonAuditDir } from "../../anonymous-chat/config.js";
import type { DeleteResult } from "../types.js";

export type AnonAuditDeleteOptions = {
  dir?: string;
  driver?: StorageDriver;
};

export async function deleteUserData(
  userId: string,
  options: AnonAuditDeleteOptions = {},
): Promise<DeleteResult> {
  void userId; // Selective deletion is impossible on the bot — see header.
  // Resolve the default prefix at call time (not module load) so it
  // tracks the writer's default regardless of cwd at import time, and
  // use the SAME normalization as the writer — a padded or blank
  // ANON_AUDIT_DIR must not make us inspect a different prefix
  // than the one records are written to.
  const dir = options.dir ?? resolveAnonAuditDir(process.env.ANON_AUDIT_DIR);

  let exists: boolean;
  try {
    exists = await hasAnonAuditRecords(dir, { driver: options.driver ?? getStorageDriver() });
  } catch (error) {
    return {
      ok: false,
      error: `anon-audit: cannot inspect audit directory: ${error instanceof Error ? error.name : "error"}`,
    };
  }
  if (!exists) {
    return { ok: true };
  }
  return {
    ok: false,
    error:
      "anonymous-chat audit records exist but cannot be selectively deleted by the bot " +
      "(no plaintext or searchable index is stored). Deletion requires the offline " +
      "audit-key custodian: run `bun run anon:audit:delete` — see docs/privacy.md.",
  };
}
