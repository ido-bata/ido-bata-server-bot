/**
 * On-disk store for `/anon` audit records (ADR-0003 §3).
 *
 * Layout: `data/anon-audit/YYYY-MM-DD.jsonl` — one JSON object per
 * anonymous post ATTEMPT that passed consent (the audit record is
 * written BEFORE the public send, so no public anonymous message can
 * exist without a durable audit record):
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
 * Files older than `retentionDays` are swept before each append. All
 * failure modes throw — the service treats them as fail-closed.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type AnonAuditPlaintext, createAnonCipher } from "./audit-crypto.js";
import type { AnonAuditConfig } from "./config.js";

const FILE_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOCK_DIR_NAME = ".anon-audit.lock";
const LOCK_OWNER_FILE = "owner";
const LOCK_HEARTBEAT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 50;

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
 * Latest heartbeat timestamp published by the lock holder, or `null`
 * when no usable owner file exists (fall back to the lock dir mtime —
 * a holder that crashed between `mkdir` and writing its owner file is
 * still detectable as stale).
 */
async function lockHeartbeatMs(lockPath: string, ownerPath: string): Promise<number | null> {
  try {
    const raw = await readFile(ownerPath, "utf8");
    const owner: unknown = JSON.parse(raw);
    if (
      owner !== null &&
      typeof owner === "object" &&
      typeof (owner as { at?: unknown }).at === "number"
    ) {
      return (owner as { at: number }).at;
    }
  } catch {
    // Owner file missing/unreadable — fall through to dir mtime.
  }
  try {
    return (await stat(lockPath)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Cross-process mutual exclusion for the audit directory. The in-process
 * promise chain below serializes callers inside one bot process; this
 * mkdir-based lock additionally serializes against a second bot process
 * or the offline custodian deletion script. `mkdir` is atomic on POSIX
 * and Windows, so it is a correct mutex primitive without extra deps.
 *
 * Ownership/liveness: the holder publishes a unique token in
 * `<lock>/owner` and refreshes it on a heartbeat. A waiter only breaks
 * a lock whose heartbeat is older than `LOCK_STALE_MS` — a live but
 * slow holder (e.g. the custodian decrypting a large history) is never
 * evicted. Release is token-checked so a holder can never delete a
 * successor's lock after a stale-break race.
 */
export async function withAnonAuditFileLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  // The audit dir must exist BEFORE the lock dir can be created inside
  // it — on a fresh deployment `mkdir(lockPath)` would fail ENOENT.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lockPath = join(dir, LOCK_DIR_NAME);
  const ownerPath = join(lockPath, LOCK_OWNER_FILE);
  const token = randomBytes(16).toString("hex");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
      const heartbeat = await lockHeartbeatMs(lockPath, ownerPath);
      if (heartbeat !== null && Date.now() - heartbeat > LOCK_STALE_MS) {
        // Abandoned lock (holder crashed or its heartbeats stopped).
        // Two concurrent breakers may both remove it — the subsequent
        // mkdir race is still safe because only one can win.
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("anon-audit: timed out acquiring directory lock", { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }

  const publishOwner = () =>
    writeFile(ownerPath, JSON.stringify({ token, pid: process.pid, at: Date.now() }), {
      encoding: "utf8",
      mode: 0o600,
    });
  await publishOwner();
  const heartbeatTimer = setInterval(() => {
    void publishOwner().catch(() => undefined);
  }, LOCK_HEARTBEAT_MS);
  heartbeatTimer.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeatTimer);
    // Release only while we still own the lock — after a stale-break
    // race the directory may belong to a successor.
    try {
      const owner: unknown = JSON.parse(await readFile(ownerPath, "utf8"));
      if (
        owner !== null &&
        typeof owner === "object" &&
        (owner as { token?: unknown }).token === token
      ) {
        await rm(lockPath, { recursive: true, force: true });
      }
    } catch {
      // Lock already gone or unreadable — nothing left to release.
    }
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
  // Eagerly create the audit dir so a fresh deployment or bad
  // permissions fails HERE — the service maps that to
  // `auditState: "error"` instead of discovering it on the first post.
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const locked = <T>(fn: () => Promise<T>) =>
    withDirLock(dir, () => withAnonAuditFileLock(dir, fn));

  return {
    seal: (plaintext) => sealFn(JSON.stringify(plaintext)),
    record: (input) =>
      locked(async () => {
        await sweepExpired(dir, config.retentionDays, Date.now());

        const line = `${JSON.stringify({
          v: 1,
          gid: input.guildId,
          cid: input.channelId,
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
