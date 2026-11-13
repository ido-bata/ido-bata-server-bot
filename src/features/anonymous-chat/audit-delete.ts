/**
 * Offline `/anon` audit deletion core (ADR-0003 §3) — custodian-only.
 *
 * Audit records are RSA-OAEP ciphertext with no bot-computable
 * per-user index, so selective deletion cannot happen on the bot
 * host. The audit-key custodian runs this OFFLINE with the private
 * key (see `src/scripts/anon-audit-delete.ts`).
 *
 * Each audit record is its own immutable file, so deletion is a
 * per-file `rm` — never a read-modify-write rewrite. A concurrent
 * bot append creates a different file and can never be lost, which
 * is why no cross-process lock is needed.
 *
 * Fail-closed contract: EVERY record file is decrypted and inspected
 * before ANY file is removed. A corrupt file, a missing `ct`, an
 * undecryptable record, or an unreadable file aborts the run — we
 * cannot prove such a record is not the target user's, so nothing is
 * touched and the caller gets an error, never a partial "success".
 * A file that vanished between listing and reading (retention sweep)
 * is already gone and is skipped.
 */
import { constants, createPrivateKey, privateDecrypt } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const FILE_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}T.*\.jsonl$/;

export type AnonAuditDeleteOutcome = {
  ok: true;
  scanned: number;
  removed: number;
};

export type AnonAuditDeleteError = {
  ok: false;
  error: string;
};

export type AnonAuditDeleteResult = AnonAuditDeleteOutcome | AnonAuditDeleteError;

type AuditRecord = { v?: unknown; ct?: unknown };

function isRecord(value: unknown): value is AuditRecord {
  return value !== null && typeof value === "object";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
  );
}

/**
 * Remove every audit record whose decrypted `userId` matches.
 * `privateKey` accepts a PEM string (PKCS8) — the custodian's key,
 * never deployed to the bot.
 */
export async function deleteAnonAuditUserRecords(options: {
  dir: string;
  privateKey: string;
  userId: string;
}): Promise<AnonAuditDeleteResult> {
  const { dir, privateKey, userId } = options;
  const key = createPrivateKey(privateKey);

  try {
    const names = (await readdir(dir)).filter((name) => FILE_NAME_PATTERN.test(name));

    // Phase 1: inspect EVERY record before removing ANY file.
    const remove: string[] = [];
    let scanned = 0;
    for (const name of names) {
      const path = join(dir, name);
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          // Swept or already deleted — nothing left to inspect.
          continue;
        }
        return {
          ok: false,
          error: `unreadable record file; nothing was modified: ${name}`,
        };
      }
      const lines = raw.split("\n").filter((line) => line.trim() !== "");
      // Records are written one-per-file; a multi-line file cannot be
      // partially deleted without a rewrite, so refuse rather than
      // risk dropping another user's record.
      if (lines.length > 1) {
        return {
          ok: false,
          error: `multi-record file ${name}; nothing was modified`,
        };
      }
      for (const line of lines) {
        scanned += 1;
        let record: AuditRecord;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!isRecord(parsed)) {
            throw new Error("not an object");
          }
          record = parsed;
        } catch {
          return { ok: false, error: `corrupt record file ${name}; nothing was modified` };
        }
        if (typeof record.ct !== "string" || record.ct.length === 0) {
          return {
            ok: false,
            error: `record file ${name} has no ciphertext; nothing was modified`,
          };
        }
        let plaintextUserId: unknown;
        try {
          const opened = privateDecrypt(
            {
              key,
              oaepHash: "sha256",
              padding: constants.RSA_PKCS1_OAEP_PADDING,
            },
            Buffer.from(record.ct, "base64"),
          ).toString("utf8");
          const plaintext: unknown = JSON.parse(opened);
          plaintextUserId =
            isRecord(plaintext) && "userId" in plaintext ? plaintext.userId : undefined;
        } catch {
          return {
            ok: false,
            error: `undecryptable record in ${name}; nothing was modified`,
          };
        }
        if (plaintextUserId === userId) {
          remove.push(name);
          break; // one record per file — no need to scan further lines
        }
      }
      // Yield periodically so large histories do not starve other work.
      await new Promise((resolve) => setImmediate(resolve));
    }

    // Phase 2: remove only after every record inspected cleanly. Each
    // file is immutable, so `rm` cannot drop a concurrent append.
    for (const name of remove) {
      await rm(join(dir, name), { force: true });
    }

    return { ok: true, scanned, removed: remove.length };
  } catch (error) {
    return {
      ok: false,
      error: `anon-audit-delete failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
