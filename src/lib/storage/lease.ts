/**
 * Instance lease — the guard against two bots processing the same events.
 *
 * During a migration cutover the old host and the Altare deployment can be
 * alive at the same time. Two bots with the same token would both answer
 * slash commands, both run the timekeeper session and both write the
 * consent registry — the last writer wins and records get lost.
 *
 * The lease lives in the same storage backend as the data, so it survives a
 * restart or redeploy and still blocks the second instance:
 *
 * - Acquisition uses `writeExclusive`, so only one instance can create it.
 * - A live lease held by a different holder aborts startup (fail closed).
 * - The holder renews the lease every TTL/3; a lease that cannot be
 *   renewed (backend down, lease taken over) is reported through
 *   `onLost` so the caller can shut the bot down instead of running
 *   unowned.
 */

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";

import { STORAGE_KEYS } from "./keys.js";
import type { StorageDriver } from "./types.js";

/** Default lease lifetime. Short enough to recover from a crashed host. */
export const DEFAULT_LEASE_TTL_MS = 60_000;

export type LeasePayload = {
  /** Identity of the owning process. */
  holderId: string;
  /** ISO timestamp of the acquisition. */
  acquiredAt: string;
  /** ISO timestamp after which the lease may be taken over. */
  expiresAt: string;
};

export class LeaseConflictError extends Error {
  readonly holderId: string;
  readonly expiresAt: string;

  constructor(holderId: string, expiresAt: string) {
    super(
      `another bot instance holds the storage lease (holder=${holderId}, expiresAt=${expiresAt})`,
    );
    this.name = "LeaseConflictError";
    this.holderId = holderId;
    this.expiresAt = expiresAt;
  }
}

export type InstanceLease = {
  /** Storage key of the lease object. */
  key: string;
  /** Identity of the owning process. */
  holderId: string;
  /** Expiry of the current lease term, epoch milliseconds. */
  expiresAtMs: number;
  /** Extend the lease. Throws when the lease was taken over. */
  renew: () => Promise<void>;
  /** Release the lease (best effort — safe to call twice). */
  release: () => Promise<void>;
};

export type AcquireLeaseOptions = {
  driver: StorageDriver;
  /** Storage key of the lease object. Defaults to `locks/instance.json`. */
  key?: string;
  /** Identity of this process. Defaults to `<host>:<pid>:<random>`. */
  holderId?: string;
  /** Lease lifetime. Defaults to 60 s. */
  ttlMs?: number;
  /** Clock override for tests. */
  now?: () => number;
  /** Called when the lease was lost. The caller should terminate the bot. */
  onLost?: (error: Error) => void;
};

export function defaultHolderId(): string {
  return `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
}

async function readLease(driver: StorageDriver, key: string): Promise<LeasePayload | null> {
  const raw = await driver.readText(key);
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LeasePayload>;
    if (typeof parsed.holderId !== "string" || typeof parsed.expiresAt !== "string") {
      return null;
    }
    return {
      acquiredAt: typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : "",
      expiresAt: parsed.expiresAt,
      holderId: parsed.holderId,
    };
  } catch {
    // A corrupt lease is treated as "unknown owner". Callers treat it as a
    // conflict rather than assuming the lease is free.
    return null;
  }
}

/**
 * Acquire the instance lease. Throws `LeaseConflictError` when another
 * instance currently holds it.
 */
export async function acquireInstanceLease(options: AcquireLeaseOptions): Promise<InstanceLease> {
  const driver = options.driver;
  const key = options.key ?? STORAGE_KEYS.instanceLease;
  const holderId = options.holderId ?? defaultHolderId();
  const ttlMs = options.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const now = options.now ?? (() => Date.now());

  const buildPayload = (): LeasePayload => ({
    acquiredAt: new Date(now()).toISOString(),
    expiresAt: new Date(now() + ttlMs).toISOString(),
    holderId,
  });

  const created = await driver.writeExclusive(key, JSON.stringify(buildPayload()));
  if (!created) {
    const current = await readLease(driver, key);
    const expiry = current ? Date.parse(current.expiresAt) : Number.NaN;
    const live = current !== null && Number.isFinite(expiry) && expiry > now();
    if (live && current) {
      throw new LeaseConflictError(current.holderId, current.expiresAt);
    }
    // The previous owner is gone (expired lease or an unreadable lease
    // object). Remove it and try once more; a losing racer sees the new
    // lease and fails with a conflict.
    await driver.delete(key);
    const retried = await driver.writeExclusive(key, JSON.stringify(buildPayload()));
    if (!retried) {
      const winner = await readLease(driver, key);
      throw new LeaseConflictError(
        winner?.holderId ?? "unknown",
        winner?.expiresAt ?? new Date(now()).toISOString(),
      );
    }
  }

  let expiresAtMs = now() + ttlMs;
  let released = false;

  const renew = async (): Promise<void> => {
    const current = await readLease(driver, key);
    if (!current || current.holderId !== holderId) {
      throw new Error(
        `storage lease was taken over by another instance (holder=${current?.holderId ?? "unknown"})`,
      );
    }
    const payload = buildPayload();
    await driver.write(key, JSON.stringify(payload));
    expiresAtMs = now() + ttlMs;
  };

  const timer = setInterval(
    () => {
      if (released) {
        return;
      }
      renew().catch((error: unknown) => {
        released = true;
        clearInterval(timer);
        options.onLost?.(error instanceof Error ? error : new Error(String(error)));
      });
    },
    Math.max(1_000, Math.floor(ttlMs / 3)),
  );
  // The renewal timer must not keep the process alive on its own.
  timer.unref?.();

  const release = async (): Promise<void> => {
    if (released) {
      return;
    }
    released = true;
    clearInterval(timer);
    try {
      const current = await readLease(driver, key);
      if (current && current.holderId === holderId) {
        await driver.delete(key);
      }
    } catch {
      // Releasing is best effort: the lease expires on its own.
    }
  };

  return {
    expiresAtMs,
    holderId,
    key,
    release,
    renew,
  };
}
