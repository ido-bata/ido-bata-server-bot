/**
 * Valkey (Redis-compatible) implementation of the storage port.
 *
 * U3 — the data backend on Altare — does not implement S3 conditional
 * writes (verified against the real endpoint: `If-None-Match` and
 * `If-Match` are ignored), so it cannot hold an exclusive instance lease.
 * Valkey can: `SET … NX` is atomic and the compare-and-swap below runs as
 * a single Lua script, which makes it the lease backend on Altare
 * (`LEASE_STORAGE_BACKEND=valkey`, `REDIS_URL` injected by
 * `altr valkey attach`). See ADR-0004 §10.
 *
 * Layout: every storage key maps to one Redis string
 * `<prefix><key>` holding a JSON envelope
 * `{"v":<version>,"m":<mtime ms>,"s":<size>,"d":"<base64>"}`. The
 * envelope keeps `readVersioned`/`compareAndSwap`/`list` atomic without a
 * second key: every mutation is a single Lua script or a single `SET`,
 * so a reader never observes a torn object.
 */

import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

import { createClient, type RedisClientType } from "redis";

import {
  type CompareAndSwapResult,
  decodeStorageText,
  encodeStorageData,
  normalizeStorageKey,
  type StorageDriver,
  type StorageEntry,
  type VersionedObject,
} from "./types.js";

const DEFAULT_KEY_PREFIX = "storage:";

type Envelope = {
  /** Monotonic version, incremented on every write. */
  v: number;
  /** Last modification time, epoch milliseconds. */
  m: number;
  /** Payload size in bytes. */
  s: number;
  /** Payload, base64. */
  d: string;
};

export type ValkeyStorageOptions = {
  /** Connection URL, e.g. `rediss://user:pass@host:port`. */
  url: string;
  /** Key prefix inside the keyspace. Defaults to `storage:`. */
  prefix?: string;
};

// Increment the envelope version and store the new payload atomically.
const WRITE_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
local v = 0
if cur then
  v = tonumber(string.match(cur, '"v":(%d+)')) or 0
end
local env = '{"v":' .. (v + 1) .. ',"m":' .. ARGV[2] .. ',"s":' .. ARGV[3] .. ',"d":"' .. ARGV[1] .. '"}'
redis.call('SET', KEYS[1], env)
return v + 1
`;

// Compare-and-swap: ARGV[1] = expected version (-1 = must not exist),
// ARGV[2] = base64 payload, ARGV[3] = mtime, ARGV[4] = size.
const CAS_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
local cv = nil
if cur then
  cv = tonumber(string.match(cur, '"v":(%d+)'))
end
local ev = tonumber(ARGV[1])
if (cv == nil and ev ~= -1) or (cv ~= nil and cv ~= ev) then
  return 0
end
local env = '{"v":' .. (cv or 0) + 1 .. ',"m":' .. ARGV[3] .. ',"s":' .. ARGV[4] .. ',"d":"' .. ARGV[2] .. '"}'
redis.call('SET', KEYS[1], env)
return 1
`;

function parseEnvelope(raw: string | null): Envelope | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Envelope>;
    if (
      typeof parsed.v !== "number" ||
      typeof parsed.m !== "number" ||
      typeof parsed.s !== "number" ||
      typeof parsed.d !== "string"
    ) {
      return null;
    }
    return { d: parsed.d, m: parsed.m, s: parsed.s, v: parsed.v };
  } catch {
    return null;
  }
}

function envelopeFor(data: Uint8Array, version: number, mtimeMs: number): string {
  return JSON.stringify({
    d: Buffer.from(data).toString("base64"),
    m: mtimeMs,
    s: data.byteLength,
    v: version,
  });
}

/** Escape Redis glob metacharacters in a key fragment. */
function escapeGlob(fragment: string): string {
  return fragment.replace(/[\\*?[\]]/g, (char) => `\\${char}`);
}

export function createValkeyStorage(options: ValkeyStorageOptions): StorageDriver {
  if (!options.url) {
    throw new Error("valkey storage: connection url is required");
  }

  const prefix = options.prefix ?? DEFAULT_KEY_PREFIX;
  // Altare Valkey serves TLS with a self-signed certificate and ships no
  // CA to pin, so `rediss://` connections skip chain validation. The
  // channel is still encrypted; the residual risk is a MITM on the lease
  // backend, which is accepted for the managed-provider deployment
  // (ADR-0004 §10).
  const client: RedisClientType = createClient(
    options.url.startsWith("rediss://")
      ? // Altare Valkey serves TLS with a self-signed certificate and ships
        // no CA to pin, so `rediss://` connections skip chain validation.
        // The channel is still encrypted; the residual risk is a MITM on
        // the lease backend, accepted for the managed deployment (ADR-0004 §10).
        { socket: { rejectUnauthorized: false, tls: true }, url: options.url }
      : { url: options.url },
  );
  // Connection errors surface through the command that needed them; an
  // unhandled 'error' event would crash the process instead.
  client.on("error", () => undefined);

  let connecting: Promise<unknown> | null = null;
  function ensureConnected(): Promise<unknown> {
    if (!connecting) {
      connecting = client.connect().catch((error: unknown) => {
        connecting = null;
        throw error;
      });
    }
    return connecting;
  }

  function redisKey(key: string): string {
    return `${prefix}${normalizeStorageKey(key)}`;
  }

  async function readEnvelope(key: string): Promise<Envelope | null> {
    await ensureConnected();
    return parseEnvelope(await client.get(redisKey(key)));
  }

  return {
    kind: "valkey",

    async read(key: string): Promise<Uint8Array | null> {
      const envelope = await readEnvelope(key);
      return envelope === null ? null : new Uint8Array(Buffer.from(envelope.d, "base64"));
    },

    async readText(key: string): Promise<string | null> {
      const bytes = await this.read(key);
      return bytes === null ? null : decodeStorageText(bytes);
    },

    async readVersioned(key: string): Promise<VersionedObject | null> {
      const envelope = await readEnvelope(key);
      if (envelope === null) {
        return null;
      }
      return {
        data: new Uint8Array(Buffer.from(envelope.d, "base64")),
        version: String(envelope.v),
      };
    },

    async write(key: string, data: Uint8Array | string): Promise<void> {
      const bytes = encodeStorageData(data);
      await ensureConnected();
      await client.eval(WRITE_SCRIPT, {
        arguments: [
          Buffer.from(bytes).toString("base64"),
          String(Date.now()),
          String(bytes.byteLength),
        ],
        keys: [redisKey(key)],
      });
    },

    async writeExclusive(key: string, data: Uint8Array | string): Promise<boolean> {
      const bytes = encodeStorageData(data);
      await ensureConnected();
      const created = await client.set(redisKey(key), envelopeFor(bytes, 1, Date.now()), {
        NX: true,
      });
      return created === "OK";
    },

    async compareAndSwap(
      key: string,
      data: Uint8Array | string,
      expectedVersion: string | null,
    ): Promise<CompareAndSwapResult> {
      const bytes = encodeStorageData(data);
      await ensureConnected();
      const result = await client.eval(CAS_SCRIPT, {
        arguments: [
          expectedVersion ?? "-1",
          Buffer.from(bytes).toString("base64"),
          String(Date.now()),
          String(bytes.byteLength),
        ],
        keys: [redisKey(key)],
      });
      return result === 1 ? "written" : "conflict";
    },

    async list(prefixFilter: string): Promise<StorageEntry[]> {
      const normalized = prefixFilter === "" ? "" : normalizeStorageKey(prefixFilter);
      const match = `${prefix}${escapeGlob(normalized)}*`;
      const entries: StorageEntry[] = [];
      let cursor = "0";
      do {
        await ensureConnected();
        const scanned = await client.scan(cursor, { MATCH: match, COUNT: 200 });
        cursor = scanned.cursor;
        for (const redisKeyName of scanned.keys) {
          const storageKey = redisKeyName.startsWith(prefix)
            ? redisKeyName.slice(prefix.length)
            : redisKeyName;
          const envelope = parseEnvelope(await client.get(redisKeyName));
          if (envelope === null) {
            continue;
          }
          entries.push({ key: storageKey, lastModifiedMs: envelope.m, size: envelope.s });
        }
      } while (cursor !== "0");
      return entries.sort((left, right) => left.key.localeCompare(right.key));
    },

    async delete(key: string): Promise<void> {
      await ensureConnected();
      await client.del(redisKey(key));
    },

    async exists(key: string): Promise<boolean> {
      await ensureConnected();
      return (await client.exists(redisKey(key))) === 1;
    },

    async move(from: string, to: string): Promise<void> {
      await ensureConnected();
      await client.rename(redisKey(from), redisKey(to));
    },

    async probeConditionalWrites(): Promise<boolean> {
      const probeKey = `${prefix}__probe-${randomBytes(6).toString("hex")}`;
      const cleanup = async (): Promise<void> => {
        await ensureConnected();
        await client.del(probeKey).catch(() => undefined);
      };
      try {
        await ensureConnected();
        // create-if-absent must succeed once and fail the second time.
        const first = await client.set(
          probeKey,
          envelopeFor(encodeStorageData("p1"), 1, Date.now()),
          {
            NX: true,
          },
        );
        if (first !== "OK") {
          await cleanup();
          return false;
        }
        const second = await client.set(
          probeKey,
          envelopeFor(encodeStorageData("p2"), 1, Date.now()),
          {
            NX: true,
          },
        );
        if (second !== null) {
          await cleanup();
          return false;
        }
        // conditional update: the current version must succeed, a stale
        // one must conflict.
        const written = await client.eval(CAS_SCRIPT, {
          arguments: ["1", Buffer.from("p3").toString("base64"), String(Date.now()), "2"],
          keys: [probeKey],
        });
        if (written !== 1) {
          await cleanup();
          return false;
        }
        const stale = await client.eval(CAS_SCRIPT, {
          arguments: ["1", Buffer.from("p4").toString("base64"), String(Date.now()), "2"],
          keys: [probeKey],
        });
        await cleanup();
        return stale === 0;
      } catch {
        await cleanup().catch(() => undefined);
        return false;
      }
    },
  };
}
