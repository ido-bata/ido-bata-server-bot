/**
 * Offline `/anon` audit deletion — custodian-only CLI (ADR-0003 §3).
 *
 * The bot stores audit records as RSA-OAEP ciphertext with no
 * bot-computable per-user index, so selective deletion cannot happen
 * on the bot host. The audit-key custodian runs this OFFLINE with the
 * private key:
 *
 *   bun run anon:audit:delete -- --key-file /secure/path/private.pem \
 *     --dir data/anon-audit --user <discord-user-id>
 *
 * The private key must never live on the bot host; this script is
 * meant to run on the custodian's own machine. Prefer `--dir`
 * pointing at the LIVE audit directory (quiet window); a copy-based
 * run changes only the copy — the custodian must then apply the same
 * deletions to the authoritative directory, and records created
 * after the copy are not covered by that run. See
 * `src/features/anonymous-chat/audit-delete.ts` for the
 * fail-closed deletion semantics.
 */
import { readFile } from "node:fs/promises";

import { deleteAnonAuditUserRecords } from "../features/anonymous-chat/audit-delete.js";
import { appendAnonAuditOperation } from "../features/anonymous-chat/audit-ops.js";
import { resolveAnonAuditDir } from "../features/anonymous-chat/config.js";

function parseArgs(argv: string[]): { keyFile: string; dir: string; userId: string } {
  const args: { keyFile?: string; dir?: string; userId?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--key-file" && value) {
      args.keyFile = value;
      i += 1;
    } else if (flag === "--dir" && value) {
      args.dir = value;
      i += 1;
    } else if (flag === "--user" && value) {
      args.userId = value;
      i += 1;
    }
  }
  if (!args.keyFile || !args.dir || !args.userId) {
    console.error(
      "usage: anon-audit-delete --key-file <private-key.pem> --dir <audit-dir> --user <userId>",
    );
    process.exit(2);
  }
  return args as { keyFile: string; dir: string; userId: string };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const privateKey = await readFile(args.keyFile, "utf8");

  const result = await deleteAnonAuditUserRecords({
    dir: args.dir,
    privateKey,
    userId: args.userId,
  });
  if (!result.ok) {
    console.error(`anon-audit-delete: ${result.error}`);
    process.exitCode = 1;
    return;
  }
  // Operation record: counts only — never the user id or contents.
  await appendAnonAuditOperation(resolveAnonAuditDir(args.dir), {
    op: "delete",
    scanned: result.scanned,
    removed: result.removed,
    keys: 1,
  }).catch(() => {});
  console.log(`anon-audit-delete: scanned=${result.scanned} removed=${result.removed}`);
}

main().catch((error: unknown) => {
  console.error(`anon-audit-delete: failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
