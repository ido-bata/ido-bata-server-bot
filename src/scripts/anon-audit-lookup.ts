/**
 * Offline `/anon` audit lookup — custodian-only CLI (ADR-0003 §3,
 * Issue #118).
 *
 * The bot stores audit records as RSA-OAEP ciphertext with no
 * bot-computable per-user index, so mapping a Discord `messageId` (or
 * user id) to an author requires the offline-held private key. The
 * audit-key custodian runs this OFFLINE — never on the bot host:
 *
 *   bun run anon:audit:lookup -- --key-file /secure/private.pem \
 *     --dir data/anon-audit --message <discord-message-id>
 *
 * Filters (exactly one required): --message <id>, --user <id>,
 * --attempt <attemptId>, --unmatched (attempt records lacking a
 * posted link — anomaly report). --key-file may be repeated for
 * rotation overlap; each record is tried against all provided keys.
 *
 * Operation audit is MANDATORY: a `start` record must be durable
 * before any decryption runs, and an `end` record must be durable
 * BEFORE plaintext is printed. If either append fails the tool
 * aborts/withholds — decrypted mappings are never disclosed without
 * a complete operation record. Entries live in
 * <dir>/operations.jsonl (counts only, never query values or
 * ciphertext).
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import type { AnonAuditLookupResult } from "../features/anonymous-chat/audit-lookup.js";
import { lookupAnonAuditRecords } from "../features/anonymous-chat/audit-lookup.js";
import type { AnonAuditOperation } from "../features/anonymous-chat/audit-ops.js";
import { appendAnonAuditOperation } from "../features/anonymous-chat/audit-ops.js";
import { resolveAnonAuditDir } from "../features/anonymous-chat/config.js";

const USAGE =
  "usage: anon-audit-lookup --key-file <private-key.pem> [--key-file ...] --dir <audit-dir> " +
  "(--message <id> | --user <id> | --attempt <id> | --unmatched)";

type ParsedArgs = {
  keyFiles: string[];
  dir: string;
  messageId?: string;
  userId?: string;
  attemptId?: string;
  unmatched: boolean;
};

function parseArgs(argv: string[]): ParsedArgs | null {
  const args: {
    keyFiles: string[];
    dir?: string;
    messageId?: string;
    userId?: string;
    attemptId?: string;
    unmatched: boolean;
  } = { keyFiles: [], unmatched: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--key-file" && value) {
      args.keyFiles.push(value);
      i += 1;
    } else if (flag === "--dir" && value) {
      args.dir = value;
      i += 1;
    } else if (flag === "--message" && value) {
      args.messageId = value;
      i += 1;
    } else if (flag === "--user" && value) {
      args.userId = value;
      i += 1;
    } else if (flag === "--attempt" && value) {
      args.attemptId = value;
      i += 1;
    } else if (flag === "--unmatched") {
      args.unmatched = true;
    }
  }
  const filters = [args.messageId, args.userId, args.attemptId].filter(Boolean).length;
  if (args.keyFiles.length === 0 || !args.dir || filters + (args.unmatched ? 1 : 0) !== 1) {
    return null;
  }
  return { ...args, dir: args.dir };
}

export type AnonAuditLookupCliDeps = {
  appendOperation?: (dir: string, entry: AnonAuditOperation) => Promise<void>;
  readKeyFile?: (path: string) => Promise<string>;
  lookup?: (options: {
    dir: string;
    privateKeys: string[];
    filter: {
      messageId?: string;
      userId?: string;
      attemptId?: string;
      unmatchedAttempts?: boolean;
    };
  }) => Promise<AnonAuditLookupResult>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
};

/**
 * Run the lookup CLI. Returns the process exit code. Injectable deps
 * exist for failure-injection tests — production callers use defaults.
 */
export async function runAnonAuditLookup(
  argv: string[],
  deps: AnonAuditLookupCliDeps = {},
): Promise<number> {
  const appendOperation = deps.appendOperation ?? appendAnonAuditOperation;
  const readKey = deps.readKeyFile ?? ((path: string) => readFile(path, "utf8"));
  const lookup = deps.lookup ?? lookupAnonAuditRecords;
  const out = deps.stdout ?? ((text: string) => console.log(text));
  const err = deps.stderr ?? ((text: string) => console.error(text));

  const args = parseArgs(argv);
  if (!args) {
    err(USAGE);
    return 2;
  }
  const dir = resolveAnonAuditDir(args.dir);

  let privateKeys: string[];
  try {
    privateKeys = await Promise.all(args.keyFiles.map((f) => readKey(f)));
  } catch {
    err("anon-audit-lookup: cannot read a private key file");
    return 1;
  }

  // Mandatory operation audit: the start record must be durable
  // before any ciphertext is decrypted. No record → no lookup.
  try {
    await appendOperation(dir, {
      op: "lookup",
      phase: "start",
      keys: privateKeys.length,
    });
  } catch {
    err("anon-audit-lookup: operation log unavailable; aborted before decryption");
    return 1;
  }

  const result = await lookup({
    dir,
    privateKeys,
    filter: {
      messageId: args.messageId,
      userId: args.userId,
      attemptId: args.attemptId,
      unmatchedAttempts: args.unmatched,
    },
  });
  if (!result.ok) {
    // The start record already documents the attempted operation;
    // nothing was disclosed, so no end record is required.
    err(`anon-audit-lookup: ${result.error}`);
    return 1;
  }

  // The end record must be durable BEFORE plaintext leaves the tool:
  // if it cannot be written, the decrypted mappings are withheld and
  // the run reports failure — disclosure never completes unrecorded.
  try {
    await appendOperation(dir, {
      op: "lookup",
      phase: "end",
      scanned: result.scanned,
      results: result.matched.length + result.unmatchedAttempts.length,
    });
  } catch {
    err("anon-audit-lookup: operation record failed; decrypted results withheld");
    return 1;
  }

  for (const match of result.matched) {
    out(JSON.stringify(match.plaintext));
  }
  for (const attempt of result.unmatchedAttempts) {
    out(JSON.stringify({ unmatchedAttempt: true, ...attempt }));
  }
  err(
    `anon-audit-lookup: scanned=${result.scanned} matched=${result.matched.length} unmatched=${result.unmatchedAttempts.length}`,
  );
  return 0;
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  runAnonAuditLookup(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`anon-audit-lookup: failed: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    });
}
