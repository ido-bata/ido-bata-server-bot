/**
 * On-disk store for `/anon` audit records (ADR-0003 §3).
 *
 * Layout: `data/anon-audit/<UTC timestamp>-<random>.jsonl` — ONE
 * immutable file per anonymous post attempt that passed consent. The
 * audit record is written BEFORE the public send, so no public
 * anonymous message can exist without a durable audit record:
 *
 *   { v, gid, cid, ct }
 *
 * - `gid`/`cid` : plaintext operational metadata (guild, channel).
 *   Never the message body, never the user id. There is no plaintext
 *   message id: Discord assigns it only after send, and the audit
 *   record must exist before the send — the custodian correlates via
 *   the decrypted `channelId` + `postedAt`.
 * - `ct`   : base64 RSA-OAEP ciphertext of the author mapping
 *   `{ userId, guildId, channelId, postedAt }`. Only the
 *   offline key holder can open it.
 *
 * There is intentionally NO per-user lookup index: any deterministic
 * tag computable by the bot is dictionary-attackable over the public
 * guild roster, so the bot host must not be able to re-identify
 * authors. Selective deletion is an offline custodian operation
 * (`src/scripts/anon-audit-delete.ts`); the bot-side privacy consumer
 * reports that honestly instead of claiming a deletion it cannot do.
 *
 * Concurrency: every record is its own immutable file, so appends are
 * atomic creations (`wx`) and never share mutable state — no lock is
 * required. The retention sweep only removes files whose UTC date
 * prefix is older than `retentionDays`, which can never include a
 * file being appended (appends always carry today's date). The
 * custodian deletion script deletes whole files, never rewrites
 * them, so a concurrent append can never be lost.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type AnonAuditPlaintext, createAnonCipher } from "./audit-crypto.js";
import type { AnonAuditConfig } from "./config.js";

const FILE_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}T.*\.jsonl$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export type AnonAuditRecordInput = {
  userId: string;
  guildId: string;
  channelId: string;
  postedAt: string;
  /** base64 RSA-OAEP ciphertext produced by `sink.seal`. */
  ciphertext: string;
};

export type AnonAuditSink = {
  /** RSA-OAEP seal the author mapping. Throws on crypto failure. */
  seal: (plaintext: AnonAuditPlaintext) => string;
  /** Persist a sealed record for a post attempt (before the send). */
  record: (input: AnonAuditRecordInput) => Promise<void>;
  /** Sweep expired record files without appending. */
  sweep: () => Promise<void>;
};

/**
 * Record file name: UTC timestamp + random suffix. The leading
 * `YYYY-MM-DD` date drives retention; the random suffix makes every
 * append an independent immutable file.
 */
function recordFileName(date: Date): string {
  const stamp = date.toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${randomBytes(8).toString("hex")}.jsonl`;
}

function fileDay(name: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T/.exec(name);
  return match?.[1] ?? null;
}

async function sweepExpired(dir: string, retentionDays: number, nowMs: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  const cutoff = nowMs - retentionDays * DAY_MS;
  for (const name of entries) {
    const day = fileDay(name);
    if (!day || !name.endsWith(".jsonl")) {
      continue;
    }
    const dayStart = Date.parse(`${day}T00:00:00.000Z`);
    if (Number.isFinite(dayStart) && dayStart < cutoff) {
      await rm(join(dir, name), { force: true });
    }
  }
}

/**
 * Build the audit sink for a resolved config. Throws when the public
 * key material is invalid or the audit directory cannot be created —
 * the caller treats that as "audit broken" and must refuse to post
 * rather than degrade to unlogged anonymity.
 */
export function createAnonAuditSink(config: AnonAuditConfig): AnonAuditSink {
  const sealFn = createAnonCipher(config.publicKey);
  const dir = config.dir;
  // Eagerly create the audit dir so a fresh deployment or bad
  // permissions fails HERE — the service maps that to
  // `auditState: "error"` instead of discovering it on the first post.
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  return {
    seal: (plaintext) => sealFn(JSON.stringify(plaintext)),
    record: async (input) => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await sweepExpired(dir, config.retentionDays, Date.now());
      const line = `${JSON.stringify({
        v: 1,
        gid: input.guildId,
        cid: input.channelId,
        ct: input.ciphertext,
      })}\n`;
      // `wx` fails if the name somehow exists — never overwrite a
      // record. Each record is an independent file, so concurrent
      // appends cannot interleave or lose each other's data.
      await writeFile(join(dir, recordFileName(new Date())), line, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    },
    sweep: async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await sweepExpired(dir, config.retentionDays, Date.now());
    },
  };
}

/**
 * Whether the audit directory currently holds any non-empty record
 * file. Used by the `/privacy delete` consumer: the bot cannot
 * selectively delete ciphertext-only records, so it must at least
 * detect that records exist and report the honest outcome.
 */
export async function hasAnonAuditRecords(dir: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  for (const name of entries) {
    if (!FILE_NAME_PATTERN.test(name)) {
      continue;
    }
    try {
      const info = await stat(join(dir, name));
      if (info.size > 0) {
        return true;
      }
    } catch {
      // Unreadable file → treat as "records may exist" (fail closed).
      return true;
    }
  }
  return false;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
  );
}
