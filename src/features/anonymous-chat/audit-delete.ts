/**
 * Offline `/anon` audit deletion core (ADR-0003 §3) — custodian-only.
 *
 * Audit records are RSA-OAEP ciphertext with no bot-computable
 * per-user index, so selective deletion cannot happen on the bot
 * host. The audit-key custodian runs this OFFLINE with the private
 * key (see `src/scripts/anon-audit-delete.ts`).
 *
 * Current records are one-per-file and published atomically, so
 * deletion is a per-file `rm` — a concurrent bot append creates a
 * different file and can never be lost. Legacy daily files
 * (`YYYY-MM-DD.jsonl`, one record per line, written by earlier
 * revisions) are handled by kept-lines rewrite: no current writer
 * targets those names, so the rewrite cannot race an append.
 *
 * Fail-closed contract: EVERY record file is decrypted and inspected
 * before ANY file is modified. A corrupt file, a missing `ct`, an
 * undecryptable record, an unreadable file, an empty file, or a
 * multi-record CURRENT-format file aborts the run — we cannot prove
 * such content is not the target user's, so nothing is touched and
 * the caller gets an error, never a partial "success". A file that
 * vanished between listing and reading (retention sweep) is already
 * gone and is skipped.
 */
import { constants, createPrivateKey, privateDecrypt, randomBytes } from "node:crypto";
import { lstat, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Current per-record names (`YYYY-MM-DDT…-rand.jsonl`) plus legacy
// daily files (`YYYY-MM-DD.jsonl`).
const FILE_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T.*)?\.jsonl$/;
const LEGACY_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

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

type Plan =
  | { kind: "remove-file"; name: string }
  | { kind: "rewrite-file"; name: string; kept: string[] };

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

  // A record we cannot fully parse — bad JSON, failed decrypt, or a
  // plaintext that does not match the sealed schema — might belong
  // to the target user, so it aborts the whole run rather than being
  // silently treated as "someone else's record".
  const decryptUserId = (ct: string): string => {
    const opened = privateDecrypt(
      {
        key,
        oaepHash: "sha256",
        padding: constants.RSA_PKCS1_OAEP_PADDING,
      },
      Buffer.from(ct, "base64"),
    ).toString("utf8");
    const plaintext: unknown = JSON.parse(opened);
    if (
      !isRecord(plaintext) ||
      !("userId" in plaintext) ||
      typeof plaintext.userId !== "string" ||
      !("guildId" in plaintext) ||
      typeof plaintext.guildId !== "string" ||
      !("channelId" in plaintext) ||
      typeof plaintext.channelId !== "string" ||
      !("postedAt" in plaintext) ||
      typeof plaintext.postedAt !== "string"
    ) {
      throw new Error("malformed decrypted record");
    }
    return plaintext.userId;
  };

  try {
    const entries = await readdir(dir);
    const names = entries.filter((name) => FILE_NAME_PATTERN.test(name));
    // Hidden temp files may be hard-link aliases to published
    // ciphertext — a record file deletion must not leave one behind.
    const tempNames = entries.filter((name) => name.endsWith(".tmp"));

    // Phase 1: inspect EVERY record before modifying ANY file.
    const plans: Plan[] = [];
    let scanned = 0;
    let removed = 0;
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
      const legacy = LEGACY_NAME_PATTERN.test(name);
      // An empty record file can be an interrupted write — it might
      // be hiding the target user's record, so refuse rather than
      // assume it is safe.
      if (lines.length === 0) {
        return { ok: false, error: `empty record file ${name}; nothing was modified` };
      }
      // Current-format files hold exactly one record; a multi-line
      // current file cannot be partially deleted without a rewrite
      // that could race nothing — but we refuse anyway because the
      // layout is unexpected. Legacy daily files legitimately hold
      // many lines.
      if (!legacy && lines.length > 1) {
        return {
          ok: false,
          error: `multi-record file ${name}; nothing was modified`,
        };
      }

      const kept: string[] = [];
      let fileRemoves = 0;
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
        let plaintextUserId: string;
        try {
          plaintextUserId = decryptUserId(record.ct);
        } catch {
          return {
            ok: false,
            error: `undecryptable or malformed record in ${name}; nothing was modified`,
          };
        }
        if (plaintextUserId === userId) {
          removed += 1;
          fileRemoves += 1;
          continue;
        }
        kept.push(line);
      }

      if (!legacy) {
        // One record per file: either the whole file goes or it stays.
        if (fileRemoves > 0) {
          plans.push({ kind: "remove-file", name });
        }
      } else if (fileRemoves > 0) {
        plans.push(
          kept.length === 0 ? { kind: "remove-file", name } : { kind: "rewrite-file", name, kept },
        );
      }
      // Yield periodically so large histories do not starve other work.
      await new Promise((resolve) => setImmediate(resolve));
    }

    // Phase 2: modify only after every record inspected cleanly.
    // Drop temp files first: they can be hard-link aliases to the
    // ciphertext about to be deleted, so a completed run must not
    // leave any behind. An in-flight bot write loses its temp and
    // its publish then fails — the post is refused, never sent
    // unaudited (fail closed).
    for (const tempName of tempNames) {
      await rm(join(dir, tempName), { force: true });
    }
    for (const plan of plans) {
      const path = join(dir, plan.name);
      if (plan.kind === "remove-file") {
        await rm(path, { force: true });
        continue;
      }
      // Legacy rewrite: temp file + atomic rename (replace semantics —
      // the legacy file exists by design). No current writer targets
      // `YYYY-MM-DD.jsonl` names, so this cannot race an append; two
      // concurrent custodian runs are an ops error.
      const tempPath = join(dir, `.${plan.name}-${randomBytes(8).toString("hex")}.tmp`);
      try {
        await writeFile(tempPath, `${plan.kept.join("\n")}\n`, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
      } catch (error) {
        // EEXIST: the temp belongs to another attempt — never remove
        // a file we did not create. Any other failure means `wx` did
        // not hand the name to someone else, so a partial file here
        // can only be ours.
        if (!(isNodeError(error) && error.code === "EEXIST")) {
          await rm(tempPath, { force: true }).catch(() => {});
        }
        throw error;
      }
      // Re-check the target immediately before publishing: if the
      // retention sweep removed the legacy file after inspection,
      // every record in it is already gone — recreating it via
      // rename would resurrect expired ciphertext. (A sweep landing
      // in the remaining window is self-correcting: the recreated
      // file keeps its old date prefix and the next sweep removes it
      // again.)
      try {
        await lstat(path);
      } catch (error) {
        await rm(tempPath, { force: true }).catch(() => {});
        if (isNodeError(error) && error.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      try {
        await rename(tempPath, path);
      } catch (error) {
        await rm(tempPath, { force: true }).catch(() => {});
        throw error;
      }
    }

    return { ok: true, scanned, removed };
  } catch (error) {
    return {
      ok: false,
      error: `anon-audit-delete failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
