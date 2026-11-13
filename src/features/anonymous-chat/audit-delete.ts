/**
 * Offline `/anon` audit deletion core (ADR-0003 §3) — custodian-only.
 *
 * Audit records are RSA-OAEP ciphertext with no bot-computable
 * per-user index, so selective deletion cannot happen on the bot
 * host. The audit-key custodian runs this OFFLINE with the private
 * key (see `src/scripts/anon-audit-delete.ts`).
 *
 * Fail-closed contract: EVERY record in EVERY daily file is decrypted
 * and inspected before ANY file is rewritten. A corrupt line, a
 * missing `ct`, or an undecryptable record aborts the run — we cannot
 * prove such a record is not the target user's, so nothing is touched
 * and the caller gets an error, never a partial "success".
 */
import { constants, createPrivateKey, privateDecrypt, randomBytes } from "node:crypto";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { withAnonAuditFileLock } from "./audit-store.js";

const FILE_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

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
    return await withAnonAuditFileLock(dir, async () => {
      const names = (await readdir(dir)).filter((name) => FILE_NAME_PATTERN.test(name));

      // Phase 1: inspect EVERY record before touching ANY file.
      const plans: { name: string; kept: string[] }[] = [];
      let scanned = 0;
      let removed = 0;
      for (const name of names) {
        const raw = await readFile(join(dir, name), "utf8");
        const kept: string[] = [];
        for (const line of raw.split("\n")) {
          if (line.trim() === "") {
            continue;
          }
          scanned += 1;
          let record: AuditRecord;
          try {
            const parsed: unknown = JSON.parse(line);
            if (!isRecord(parsed)) {
              throw new Error("not an object");
            }
            record = parsed;
          } catch {
            return { ok: false, error: `corrupt JSONL line in ${name}; nothing was modified` };
          }
          if (typeof record.ct !== "string" || record.ct.length === 0) {
            return {
              ok: false,
              error: `record in ${name} has no ciphertext; nothing was modified`,
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
            removed += 1;
            continue;
          }
          kept.push(line);
        }
        plans.push({ name, kept });
      }

      // Phase 2: rewrite only after every record inspected cleanly.
      for (const plan of plans) {
        const path = join(dir, plan.name);
        if (plan.kept.length === 0) {
          await rm(path, { force: true });
          continue;
        }
        const tempPath = `${path}.${process.pid}-${randomBytes(8).toString("hex")}.tmp`;
        await writeFile(tempPath, `${plan.kept.join("\n")}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(tempPath, path);
      }

      return { ok: true, scanned, removed };
    });
  } catch (error) {
    return {
      ok: false,
      error: `anon-audit-delete failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
