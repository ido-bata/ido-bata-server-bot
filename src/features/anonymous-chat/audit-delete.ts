/**
 * Offline `/anon` audit deletion core (ADR-0003 §3) — custodian-only.
 *
 * Audit records are RSA-OAEP ciphertext with no bot-computable
 * per-user index, so selective deletion cannot happen on the bot
 * host. The audit-key custodian runs this OFFLINE with the private
 * key (see `src/scripts/anon-audit-delete.ts`).
 *
 * Current records are one-per-object and published atomically, so
 * deletion is a per-record delete — a concurrent bot append creates a
 * different record and can never be lost. Legacy daily files
 * (`YYYY-MM-DD.jsonl`, one record per line, written by earlier
 * revisions) are handled by kept-lines rewrite: no current writer
 * targets those names, so the rewrite cannot race an append.
 *
 * Fail-closed contract: EVERY record is decrypted and inspected
 * before ANY record is modified. A corrupt record, a missing `ct`, an
 * undecryptable record, an unreadable object, an empty record, or a
 * multi-record CURRENT-format record aborts the run — we cannot prove
 * such content is not the target user's, so nothing is touched and
 * the caller gets an error, never a partial "success". A record that
 * vanished between listing and reading (retention sweep) is already
 * gone and is skipped.
 */
import { constants, createPrivateKey, privateDecrypt } from "node:crypto";

import { getStorageDriver } from "../../lib/storage/index.js";
import type { StorageDriver } from "../../lib/storage/types.js";
import { joinStorageKey } from "../../lib/storage/types.js";

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

type Plan =
  | { kind: "remove-record"; name: string }
  | { kind: "rewrite-record"; name: string; kept: string[] };

/**
 * Remove every audit record whose decrypted `userId` matches.
 * `privateKey` accepts a PEM string (PKCS8) — the custodian's key,
 * never deployed to the bot.
 */
export async function deleteAnonAuditUserRecords(options: {
  dir: string;
  privateKey: string;
  userId: string;
  /** Storage backend to operate on. Defaults to the configured backend. */
  driver?: StorageDriver;
}): Promise<AnonAuditDeleteResult> {
  const { dir, privateKey, userId } = options;
  const key = createPrivateKey(privateKey);
  const driver = options.driver ?? getStorageDriver();

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
    const entries = await driver.list(dir === "" ? "" : `${dir}/`);
    const names = entries
      .map((entry) => (dir === "" ? entry.key : entry.key.slice(`${dir}/`.length)))
      .filter((name) => FILE_NAME_PATTERN.test(name));
    // Temp leftovers from an interrupted local write can alias
    // published ciphertext — a record deletion must not leave one
    // behind.
    const tempNames = entries
      .map((entry) => (dir === "" ? entry.key : entry.key.slice(`${dir}/`.length)))
      .filter((name) => name.endsWith(".tmp"));

    // Phase 1: inspect EVERY record before modifying ANY object.
    const plans: Plan[] = [];
    let scanned = 0;
    let removed = 0;
    for (const name of names) {
      const raw = await driver.readText(joinStorageKey(dir, name));
      if (raw === null) {
        // Swept or already deleted — nothing left to inspect.
        continue;
      }
      const lines = raw.split("\n").filter((line) => line.trim() !== "");
      const legacy = LEGACY_NAME_PATTERN.test(name);
      // An empty record can be an interrupted write — it might be
      // hiding the target user's record, so refuse rather than
      // assume it is safe.
      if (lines.length === 0) {
        return { ok: false, error: `empty record file ${name}; nothing was modified` };
      }
      // Current-format records hold exactly one line; a multi-line
      // current record cannot be partially deleted without a rewrite
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
        // One record per object: either the whole record goes or it stays.
        if (fileRemoves > 0) {
          plans.push({ kind: "remove-record", name });
        }
      } else if (fileRemoves > 0) {
        plans.push(
          kept.length === 0
            ? { kind: "remove-record", name }
            : { kind: "rewrite-record", name, kept },
        );
      }
      // Yield periodically so large histories do not starve other work.
      await new Promise((resolve) => setImmediate(resolve));
    }

    // Phase 2: modify only after every record inspected cleanly.
    // Drop temp leftovers first: they can alias the ciphertext about
    // to be deleted, so a completed run must not leave any behind. An
    // in-flight bot write loses its temp and its publish then fails —
    // the post is refused, never sent unaudited (fail closed).
    for (const tempName of tempNames) {
      await driver.delete(joinStorageKey(dir, tempName));
    }
    for (const plan of plans) {
      if (plan.kind === "remove-record") {
        await driver.delete(joinStorageKey(dir, plan.name));
        continue;
      }
      // Legacy rewrite: the write is atomic (temp file + rename on the
      // local backend, a single PUT on object storage), so readers see
      // either the old or the new content. No current writer targets
      // `YYYY-MM-DD.jsonl` names, so this cannot race an append; two
      // concurrent custodian runs are an ops error.
      const current = await driver.readText(joinStorageKey(dir, plan.name));
      if (current === null) {
        // The retention sweep removed the legacy record after
        // inspection — every record in it is already gone. Recreating
        // it would resurrect expired ciphertext.
        continue;
      }
      await driver.write(joinStorageKey(dir, plan.name), `${plan.kept.join("\n")}\n`);
    }

    return { ok: true, scanned, removed };
  } catch (error) {
    return {
      ok: false,
      error: `anon-audit-delete failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
