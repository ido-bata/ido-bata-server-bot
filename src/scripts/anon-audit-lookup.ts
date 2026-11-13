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
 * Output is the DECRYPTED mapping — sensitive data; handle per the
 * custodian procedure in docs/privacy.md §8.2. An entry is appended
 * to <dir>/operations.jsonl (counts only, never query values).
 */
import { readFile } from "node:fs/promises";

import { lookupAnonAuditRecords } from "../features/anonymous-chat/audit-lookup.js";
import { appendAnonAuditOperation } from "../features/anonymous-chat/audit-ops.js";
import { resolveAnonAuditDir } from "../features/anonymous-chat/config.js";

function parseArgs(argv: string[]): {
  keyFiles: string[];
  dir: string;
  messageId?: string;
  userId?: string;
  attemptId?: string;
  unmatched: boolean;
} {
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
    console.error(
      "usage: anon-audit-lookup --key-file <private-key.pem> [--key-file ...] --dir <audit-dir> " +
        "(--message <id> | --user <id> | --attempt <id> | --unmatched)",
    );
    process.exit(2);
  }
  return { ...args, dir: args.dir } as {
    keyFiles: string[];
    dir: string;
    messageId?: string;
    userId?: string;
    attemptId?: string;
    unmatched: boolean;
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dir = resolveAnonAuditDir(args.dir);
  const privateKeys = await Promise.all(args.keyFiles.map((f) => readFile(f, "utf8")));

  const result = await lookupAnonAuditRecords({
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
    console.error(`anon-audit-lookup: ${result.error}`);
    process.exitCode = 1;
    return;
  }

  // Operation record: counts and key count only — never query values.
  await appendAnonAuditOperation(dir, {
    op: "lookup",
    scanned: result.scanned,
    matched: result.matched.length,
    keys: privateKeys.length,
  }).catch(() => {});

  for (const match of result.matched) {
    console.log(JSON.stringify(match.plaintext));
  }
  for (const attempt of result.unmatchedAttempts) {
    console.log(JSON.stringify({ unmatchedAttempt: true, ...attempt }));
  }
  console.error(
    `anon-audit-lookup: scanned=${result.scanned} matched=${result.matched.length} unmatched=${result.unmatchedAttempts.length}`,
  );
}

main().catch((error: unknown) => {
  console.error(`anon-audit-lookup: failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
