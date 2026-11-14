/**
 * Audit record store for `/anon` (ADR-0003 §3).
 *
 * Layout: `<audit-prefix>/<UTC timestamp>-<random>.jsonl` — ONE
 * immutable record per anonymous post attempt that passed consent. Two
 * records are written per anonymous post (ADR-0003 §3, Issue #118):
 *
 *   attempt — BEFORE the public send:
 *     { v: 2, kid, kind: "attempt", gid, cid, ct }
 *     ct seals { v:2, kind:"attempt", attemptId, userId, guildId,
 *                channelId, postedAt }
 *
 *   posted — immediately AFTER a successful send, carrying the real
 *     Discord messageId:
 *     { v: 2, kid, kind: "posted", gid, cid, ct }
 *     ct seals { v: 2, kind:"posted", attemptId, messageId, userId,
 *                guildId, channelId, postedAt }
 *
 * - `gid`/`cid`/`kind`/`kid`/`v` : plaintext operational metadata
 *   (guild, channel, record kind, key id). Never the message body,
 *   never the user id, never the messageId — `messageId` stays inside
 *   the ciphertext so the bot host cannot build a plaintext
 *   message→record index.
 * - `ct`   : base64 RSA-OAEP ciphertext. Only the offline key holder
 *   can open it; `kid` selects which private key applies after
 *   rotation.
 *
 * Audit is MANDATORY: the service refuses to post unless a sink is
 * active, so no public anonymous message can exist without at least
 * its attempt record, and every acknowledged post gets its posted
 * record (or the message is deleted and the feature fails closed).
 *
 * There is intentionally NO per-user lookup index: any deterministic
 * tag computable by the bot is dictionary-attackable over the public
 * guild roster, so the bot host must not be able to re-identify
 * authors. Selective deletion is an offline custodian operation
 * (`src/scripts/anon-audit-delete.ts`); the bot-side privacy consumer
 * reports that honestly instead of claiming a deletion it cannot do.
 *
 * Durability (ADR-0004): records live in the storage backend — the
 * local `data/` directory on a single host, object storage (U3) on
 * Altare. A record is published with a create-if-absent write, so a
 * reader never observes a partial record and a name collision can
 * never silently replace an existing record. The write only resolves
 * after the backend confirmed the record is durable, which is what
 * allows the public send to happen right after `record()` resolves.
 * Any storage failure aborts the publish and fails closed — the post
 * is refused rather than sent unaudited.
 */
import { randomBytes } from "node:crypto";

import { getStorageDriver } from "../../lib/storage/index.js";
import type { StorageDriver } from "../../lib/storage/types.js";
import { joinStorageKey } from "../../lib/storage/types.js";
import {
  type AnonAuditAttemptPlaintext,
  type AnonAuditPostedPlaintext,
  createAnonCipher,
} from "./audit-crypto.js";
import type { AnonAuditConfig } from "./config.js";

// Matches both the current per-record names (`YYYY-MM-DDT…-rand.jsonl`)
// and legacy daily files (`YYYY-MM-DD.jsonl`) so privacy detection and
// retention still cover data written by earlier revisions.
const FILE_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T.*)?\.jsonl$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const TMP_STALE_MS = 60 * 60 * 1000;

export type AnonAuditRecordKind = "attempt" | "posted";

export type AnonAuditRecordInput = {
  kind: AnonAuditRecordKind;
  guildId: string;
  channelId: string;
  /** base64 RSA-OAEP ciphertext produced by `sink.seal`. */
  ciphertext: string;
};

export type AnonAuditSink = {
  /** RSA-OAEP seal an attempt/posted payload. Throws on crypto failure. */
  seal: (plaintext: AnonAuditAttemptPlaintext | AnonAuditPostedPlaintext) => string;
  /** Persist a sealed record (attempt pre-send, posted post-send). */
  record: (input: AnonAuditRecordInput) => Promise<void>;
  /** Sweep expired record files without appending. */
  sweep: () => Promise<void>;
};

export type AnonAuditSinkOptions = {
  /** Storage backend the records are written to. */
  driver?: StorageDriver;
};

/**
 * Record file name: UTC timestamp + random suffix. The leading
 * `YYYY-MM-DD` date drives retention; the random suffix makes every
 * append an independent immutable record.
 */
function recordFileName(date: Date): string {
  const stamp = date.toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${randomBytes(8).toString("hex")}.jsonl`;
}

function fileDay(name: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})(?:T|\.jsonl$)/.exec(name);
  return match?.[1] ?? null;
}

async function sweepExpired(
  driver: StorageDriver,
  prefix: string,
  retentionDays: number,
  nowMs: number,
): Promise<void> {
  const entries = await driver.list(prefix === "" ? "" : `${prefix}/`);
  const cutoff = nowMs - retentionDays * DAY_MS;

  for (const entry of entries) {
    const name = prefix === "" ? entry.key : entry.key.slice(`${prefix}/`.length);
    if (!name) {
      continue;
    }
    // Orphaned temp files from an interrupted local write: hidden
    // `.*.tmp` names never match FILE_NAME_PATTERN, so remove them once
    // they are clearly stale (an in-flight write is never this old).
    if (name.endsWith(".tmp")) {
      if (nowMs - entry.lastModifiedMs > TMP_STALE_MS) {
        await driver.delete(entry.key);
      }
      continue;
    }
    const day = fileDay(name);
    if (!day || !name.endsWith(".jsonl")) {
      continue;
    }
    const dayStart = Date.parse(`${day}T00:00:00.000Z`);
    if (Number.isFinite(dayStart) && dayStart < cutoff) {
      await driver.delete(entry.key);
    }
  }
}

/**
 * Build the audit sink for a resolved config. Throws when the public
 * key material is invalid — the caller treats that as "audit broken" and
 * must refuse to post rather than degrade to unlogged anonymity.
 */
export function createAnonAuditSink(
  config: AnonAuditConfig,
  options: AnonAuditSinkOptions = {},
): AnonAuditSink {
  const sealFn = createAnonCipher(config.publicKey);
  const driver = options.driver ?? getStorageDriver();
  const prefix = config.dir;

  return {
    seal: (plaintext) => sealFn(JSON.stringify(plaintext)),

    record: async (input) => {
      await sweepExpired(driver, prefix, config.retentionDays, Date.now());
      const line = `${JSON.stringify({
        v: 2,
        kid: config.keyId,
        kind: input.kind,
        gid: input.guildId,
        cid: input.channelId,
        ct: input.ciphertext,
      })}\n`;
      // Publish with no-replace semantics: the record name carries 8
      // random bytes, and the create-if-absent write guarantees an
      // existing record is never overwritten. A collision is retried
      // with a fresh name; any other storage failure fails closed.
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        const key = joinStorageKey(prefix, recordFileName(new Date()));
        const created = await driver.writeExclusive(key, line);
        if (created) {
          return;
        }
        lastError = new Error(`anon-audit record name already exists: ${key}`);
      }
      throw lastError;
    },

    sweep: async () => {
      await sweepExpired(driver, prefix, config.retentionDays, Date.now());
    },
  };
}

/**
 * Whether the audit prefix currently holds any non-empty record.
 * Used by the `/privacy delete` consumer: the bot cannot selectively
 * delete ciphertext-only records, so it must at least detect that
 * records exist and report the honest outcome.
 */
export async function hasAnonAuditRecords(
  dir: string,
  options: AnonAuditSinkOptions = {},
): Promise<boolean> {
  const driver = options.driver ?? getStorageDriver();
  const entries = await driver.list(dir === "" ? "" : `${dir}/`);
  for (const entry of entries) {
    const name = dir === "" ? entry.key : entry.key.slice(`${dir}/`.length);
    // A leftover temp file may be an unpublished partial record — treat
    // it as "records may exist" (fail closed).
    if (name.endsWith(".tmp")) {
      return true;
    }
    if (!FILE_NAME_PATTERN.test(name)) {
      continue;
    }
    if (entry.size > 0) {
      return true;
    }
  }
  return false;
}
