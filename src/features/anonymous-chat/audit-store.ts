/**
 * On-disk store for `/anon` audit records (ADR-0003 §3).
 *
 * Layout: `data/anon-audit/YYYY-MM-DD.jsonl` — one JSON object per
 * posted anonymous message:
 *
 *   { v, gid, cid, mid, ct }
 *
 * - `gid`/`cid`/`mid` : plaintext operational metadata (guild, channel,
 *   public message id). Never the message body, never the user id.
 * - `ct`   : base64 RSA-OAEP ciphertext of the full author mapping
 *   `{ userId, guildId, channelId, messageId, postedAt }`. Only the
 *   offline key holder can open it.
 *
 * There is intentionally NO per-user lookup index: any deterministic
 * tag computable by the bot is dictionary-attackable over the public
 * guild roster, so the bot host must not be able to re-identify
 * authors. Selective deletion is an offline custodian operation
 * (`src/scripts/anon-audit-delete.ts`); the bot-side privacy consumer
 * reports that honestly instead of claiming a deletion it cannot do.
 *
 * Files older than `retentionDays` are swept before each append. All
 * failure modes throw — the service treats them as fail-closed.
 */
import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { type AnonAuditPlaintext, createAnonCipher } from "./audit-crypto.js";
import type { AnonAuditConfig } from "./config.js";

const FILE_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOCK_DIR_NAME = ".anon-audit.lock";
const LOCK_STALE_MS = 60_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 50;

export type AnonAuditRecordInput = {
  userId: string;
  guildId: string;
  channelId: string;
  messageId: string;
  postedAt: string;
  /** base64 RSA-OAEP ciphertext produced by `sink.seal`. */
  ciphertext: string;
};

export type AnonAuditSink = {
  /** RSA-OAEP seal the author mapping. Throws on crypto failure. */
  seal: (plaintext: AnonAuditPlaintext) => string;
  /** Append a sealed record for a successfully posted message. */
  record: (input: AnonAuditRecordInput) => Promise<void>;
  /** Sweep expired daily files without appending. */
  sweep: () => Promise<void>;
};

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function fileNameFor(date: Date): string {
  return `${utcDay(date)}.jsonl`;
}

/**
 * Cross-process mutual exclusion for the audit directory. The in-process
 * promise chain below serializes callers inside one bot process; this
 * mkdir-based lock additionally serializes against a second bot process
 * or the offline custodian deletion script. `mkdir` is atomic on POSIX
 * and Windows, so it is a correct mutex primitive without extra deps.
 */
export async function withAnonAuditFileLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = join(dir, LOCK_DIR_NAME);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
      // Stale lock: a crashed holder leaves the directory behind. Break
      // it only when it is clearly older than any legitimate critical
      // section could be.
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Lock vanished between mkdir and stat — retry immediately.
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("anon-audit: timed out acquiring directory lock", { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

/**
 * In-process promise-chain mutex layered on top of the file lock so
 * same-process callers do not contend on the filesystem lock.
 */
const dirLocks = new Map<string, Promise<unknown>>();

function withDirLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = dirLocks.get(dir) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  dirLocks.set(
    dir,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
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
    const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (!match) {
      continue;
    }
    const dayStart = Date.parse(`${match[1]}T00:00:00.000Z`);
    if (Number.isFinite(dayStart) && dayStart < cutoff) {
      await rm(join(dir, name), { force: true });
    }
  }
}

/**
 * Build the audit sink for a resolved config. Throws when the public
 * key material is invalid — the caller treats that as "audit broken"
 * and must refuse to post rather than degrade to unlogged anonymity.
 */
export function createAnonAuditSink(config: AnonAuditConfig): AnonAuditSink {
  const sealFn = createAnonCipher(config.publicKey);
  const dir = config.dir;

  const locked = <T>(fn: () => Promise<T>) =>
    withDirLock(dir, () => withAnonAuditFileLock(dir, fn));

  return {
    seal: (plaintext) => sealFn(JSON.stringify(plaintext)),
    record: (input) =>
      locked(async () => {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await sweepExpired(dir, config.retentionDays, Date.now());

        const line = `${JSON.stringify({
          v: 1,
          gid: input.guildId,
          cid: input.channelId,
          mid: input.messageId,
          ct: input.ciphertext,
        })}\n`;
        await appendFile(join(dir, fileNameFor(new Date())), line, {
          encoding: "utf8",
          mode: 0o600,
        });
      }),
    sweep: () => locked(() => sweepExpired(dir, config.retentionDays, Date.now())),
  };
}

/**
 * Whether the audit directory currently holds any non-empty daily
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
