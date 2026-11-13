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
 *
 * Operation audit is MANDATORY: a `start` record must be durable
 * BEFORE any record is deleted, and an `end` record must be durable
 * after. If the start append fails the deletion never runs; if the
 * end append fails the tool reports failure loudly — a deletion
 * never completes silently unrecorded. Entries live in
 * <dir>/operations.jsonl (counts only, never the user id).
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import type { AnonAuditDeleteResult } from "../features/anonymous-chat/audit-delete.js";
import { deleteAnonAuditUserRecords } from "../features/anonymous-chat/audit-delete.js";
import type { AnonAuditOperation } from "../features/anonymous-chat/audit-ops.js";
import { appendAnonAuditOperation } from "../features/anonymous-chat/audit-ops.js";
import { resolveAnonAuditDir } from "../features/anonymous-chat/config.js";

const USAGE =
  "usage: anon-audit-delete --key-file <private-key.pem> --dir <audit-dir> --user <userId>";

type ParsedArgs = { keyFile: string; dir: string; userId: string };

function parseArgs(argv: string[]): ParsedArgs | null {
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
    return null;
  }
  return args as ParsedArgs;
}

export type AnonAuditDeleteCliDeps = {
  appendOperation?: (dir: string, entry: AnonAuditOperation) => Promise<void>;
  readKeyFile?: (path: string) => Promise<string>;
  deleteRecords?: (options: {
    dir: string;
    privateKey: string;
    userId: string;
  }) => Promise<AnonAuditDeleteResult>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
};

/**
 * Run the delete CLI. Returns the process exit code. Injectable deps
 * exist for failure-injection tests — production callers use defaults.
 */
export async function runAnonAuditDelete(
  argv: string[],
  deps: AnonAuditDeleteCliDeps = {},
): Promise<number> {
  const appendOperation = deps.appendOperation ?? appendAnonAuditOperation;
  const readKey = deps.readKeyFile ?? ((path: string) => readFile(path, "utf8"));
  const deleteRecords = deps.deleteRecords ?? deleteAnonAuditUserRecords;
  const out = deps.stdout ?? ((text: string) => console.log(text));
  const err = deps.stderr ?? ((text: string) => console.error(text));

  const args = parseArgs(argv);
  if (!args) {
    err(USAGE);
    return 2;
  }
  const dir = resolveAnonAuditDir(args.dir);

  let privateKey: string;
  try {
    privateKey = await readKey(args.keyFile);
  } catch {
    err("anon-audit-delete: cannot read the private key file");
    return 1;
  }

  // Mandatory operation audit: the start record must be durable
  // BEFORE any record is deleted. No record → no deletion.
  try {
    await appendOperation(dir, { op: "delete", phase: "start", keys: 1 });
  } catch {
    err("anon-audit-delete: operation log unavailable; aborted before deletion");
    return 1;
  }

  const result = await deleteRecords({
    dir,
    privateKey,
    userId: args.userId,
  });
  if (!result.ok) {
    // The start record already documents the attempted operation.
    err(`anon-audit-delete: ${result.error}`);
    return 1;
  }

  // The end record must be durable after deletion. If it cannot be
  // written the deletion already happened — report failure loudly
  // rather than completing silently unrecorded.
  try {
    await appendOperation(dir, {
      op: "delete",
      phase: "end",
      scanned: result.scanned,
      removed: result.removed,
    });
  } catch {
    err(
      `anon-audit-delete: deletion completed (scanned=${result.scanned} removed=${result.removed}) ` +
        "but the operation record could not be written",
    );
    return 1;
  }

  // Counts only — never the user id or record contents.
  out(`anon-audit-delete: scanned=${result.scanned} removed=${result.removed}`);
  return 0;
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  runAnonAuditDelete(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`anon-audit-delete: failed: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    });
}
