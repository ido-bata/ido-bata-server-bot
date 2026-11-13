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
import { join } from "node:path";

import { hasAnonAuditRecords } from "../../anonymous-chat/audit-store.js";
import type { DeleteResult } from "../types.js";

export type AnonAuditDeleteOptions = {
  dir?: string;
};

const DEFAULT_DIR_NAME = "data/anon-audit";

export async function deleteUserData(
  userId: string,
  options: AnonAuditDeleteOptions = {},
): Promise<DeleteResult> {
  void userId; // Selective deletion is impossible on the bot — see header.
  // Resolve the default dir at call time (not module load) so the path
  // tracks the writer's `data/anon-audit` default regardless of cwd at
  // import time.
  const dir = options.dir ?? process.env.ANON_AUDIT_DIR ?? join(process.cwd(), DEFAULT_DIR_NAME);

  let exists: boolean;
  try {
    exists = await hasAnonAuditRecords(dir);
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
