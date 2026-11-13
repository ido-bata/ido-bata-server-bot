/**
 * On-disk store for `/anon` audit records (ADR-0003 §3).
 *
 * Layout: `data/anon-audit/YYYY-MM-DD.jsonl` — one JSON object per
 * posted anonymous message:
 *
 *   { v, idx, gid, cid, mid, ct }
 *
 * - `idx`  : HMAC-SHA256(indexKey, userId) — `/privacy delete` lookup.
 * - `gid`/`cid`/`mid` : plaintext operational metadata (guild, channel,
 *   public message id). Never the message body, never the user id.
 * - `ct`   : base64 RSA-OAEP ciphertext of the author mapping. Only the
 *   offline key holder can open it.
 *
 * Files older than `retentionDays` are swept before each append. All
 * failure modes throw — the service treats them as fail-closed.
 */
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type AnonAuditPlaintext, computeAnonIndex, createAnonCipher } from "./audit-crypto.js";
import type { AnonAuditConfig } from "./config.js";

const FILE_NAME_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 24 * 60 * 60 * 1000;

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
    const match = FILE_NAME_PATTERN.exec(name);
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
 * key material is invalid — the caller decides whether audit is
 * disabled (it must never fall back to plaintext).
 */
export function createAnonAuditSink(config: AnonAuditConfig): AnonAuditSink {
  const sealFn = createAnonCipher(config.publicKey);
  const dir = config.dir;

  return {
    seal: (plaintext) => sealFn(JSON.stringify(plaintext)),
    async record(input) {
      await mkdir(dir, { recursive: true });
      await sweepExpired(dir, config.retentionDays, Date.now());

      const idx = computeAnonIndex(config.indexKey, input.userId);
      const line =
        JSON.stringify({
          v: 1,
          idx,
          gid: input.guildId,
          cid: input.channelId,
          mid: input.messageId,
          ct: input.ciphertext,
        }) + "\n";
      await appendFile(join(dir, fileNameFor(new Date())), line, "utf8");
    },
    sweep: () => sweepExpired(dir, config.retentionDays, Date.now()),
  };
}

export type AnonAuditDeleteResult = { ok: true; removed: number } | { ok: false; error: string };

/**
 * Remove every audit record whose `idx` matches `computeAnonIndex
 * (indexKey, userId)`. Used by the `/privacy delete` consumer adapter.
 *
 * When `indexKey` is unavailable but audit files exist, returns
 * `ok:false` — silently succeeding would claim deletion that never
 * happened (privacy invariant: partial failure = failure).
 */
export async function deleteAnonAuditRecords(options: {
  dir: string;
  indexKey: string | undefined;
  userId: string;
}): Promise<AnonAuditDeleteResult> {
  const { dir, indexKey, userId } = options;

  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { ok: true, removed: 0 };
    }
    return { ok: false, error: `readdir failed: ${messageOf(error)}` };
  }

  const files = names.filter((name) => FILE_NAME_PATTERN.test(name));
  if (files.length === 0) {
    return { ok: true, removed: 0 };
  }
  if (!indexKey) {
    return {
      ok: false,
      error: "ANON_AUDIT_INDEX_KEY is not configured; cannot target audit records for deletion",
    };
  }

  const idx = computeAnonIndex(indexKey, userId);
  let removed = 0;

  for (const name of files) {
    const path = join(dir, name);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      return { ok: false, error: `read failed for ${name}: ${messageOf(error)}` };
    }

    const kept: string[] = [];
    let fileRemoved = 0;
    for (const line of raw.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      let record: { idx?: unknown };
      try {
        record = JSON.parse(line) as { idx?: unknown };
      } catch {
        // Corrupt line: keep it rather than silently dropping audit data.
        kept.push(line);
        continue;
      }
      if (record.idx === idx) {
        fileRemoved += 1;
        continue;
      }
      kept.push(line);
    }

    if (fileRemoved === 0) {
      continue;
    }
    removed += fileRemoved;

    try {
      if (kept.length === 0) {
        await rm(path, { force: true });
      } else {
        const tempPath = `${path}.${process.pid}-${randomBytes(8).toString("hex")}.tmp`;
        await writeFile(tempPath, `${kept.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(tempPath, path);
      }
    } catch (error) {
      return { ok: false, error: `rewrite failed for ${name}: ${messageOf(error)}` };
    }
  }

  return { ok: true, removed };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
