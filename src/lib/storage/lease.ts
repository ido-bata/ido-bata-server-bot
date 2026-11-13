/**
 * Instance lease — the guard against two bots processing the same events.
 *
 * During a migration cutover the old host and the Altare deployment can be
 * alive at the same time. Two bots with the same token would both answer
 * slash commands, both run the timekeeper session and both write the
 * consent registry — the last writer wins and records get lost.
 *
 * The lease lives in a storage backend, so it survives a restart or a
 * redeploy and still blocks the second instance. The backend is configured
 * independently of the data backend (`LEASE_STORAGE_BACKEND`), because the
 * old host must contend for the *same* lease object as the new one even
 * while its data still lives on the local disk.
 *
 * Ownership rules:
 *
 * - The lease object carries a monotonically increasing `epoch` and a
 *   per-term random `token`. Only the holder that wrote the current epoch
 *   may renew or release it.
 * - Every mutation is a compare-and-swap against the version of the object
 *   the caller read (`compareAndSwap`). A lost race reports `conflict`
 *   instead of overwriting the other holder's term.
 * - A backend that cannot do conditional writes is reported as
 *   `unsupported`; the lease then refuses to start (fail closed) instead of
 *   pretending to be exclusive.
 * - Releasing *expires* the term instead of deleting the object. A delete
 *   could remove a lease that another instance acquired in the meantime;
 *   an expired term can only be taken over through the same
 *   compare-and-swap, so the race is closed.
 * - A holder that cannot renew (backend down, term taken over) reports the
 *   loss through `onLost`; the composition root shuts the bot down instead
 *   of running unowned.
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
  /** Monotonic term counter. A takeover increments it. */
  epoch: number;
  /** ISO timestamp of the acquisition of this term. */
  acquiredAt: string;
  /** ISO timestamp after which the term may be taken over. */
  expiresAt: string;
  /** Random secret proving ownership of this term. */
  token: string;
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

/** The backend cannot provide the exclusivity the lease needs. */
export class LeaseUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseUnsupportedError";
  }
}

/** The lease was taken over by another instance. */
export class LeaseLostError extends Error {
  readonly holderId: string;

  constructor(holderId: string) {
    super(`the storage lease was taken over by another instance (holder=${holderId})`);
    this.name = "LeaseLostError";
    this.holderId = holderId;
  }
}

export type InstanceLease = {
  /** Storage key of the lease object. */
  key: string;
  /** Identity of the owning process. */
  holderId: string;
  /** The term this instance owns. */
  epoch: number;
  /** Expiry of the current term, epoch milliseconds. */
  expiresAtMs: number;
  /** Extend the term. Throws `LeaseLostError` when the term was taken over. */
  renew: () => Promise<void>;
  /** Expire the term (best effort — safe to call twice). */
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

function parseLease(raw: string): LeasePayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const candidate = parsed as Partial<LeasePayload>;
  if (
    typeof candidate.holderId !== "string" ||
    typeof candidate.expiresAt !== "string" ||
    typeof candidate.token !== "string" ||
    typeof candidate.epoch !== "number"
  ) {
    return null;
  }
  return {
    acquiredAt: typeof candidate.acquiredAt === "string" ? candidate.acquiredAt : "",
    epoch: candidate.epoch,
    expiresAt: candidate.expiresAt,
    holderId: candidate.holderId,
    token: candidate.token,
  };
}

/**
 * Acquire the instance lease. Throws `LeaseConflictError` when another
 * instance currently holds it, and `LeaseUnsupportedError` when the
 * backend cannot guarantee exclusivity.
 */
export async function acquireInstanceLease(options: AcquireLeaseOptions): Promise<InstanceLease> {
  const driver = options.driver;
  const key = options.key ?? STORAGE_KEYS.instanceLease;
  const holderId = options.holderId ?? defaultHolderId();
  const ttlMs = options.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const now = options.now ?? (() => Date.now());

  const buildPayload = (epoch: number): LeasePayload => ({
    acquiredAt: new Date(now()).toISOString(),
    epoch,
    expiresAt: new Date(now() + ttlMs).toISOString(),
    holderId,
    token: randomBytes(16).toString("hex"),
  });

  // The exclusivity of the lease depends on conditional writes. Probe the
  // backend before handing out a term: a backend that ignores the
  // conditions would let two instances believe they own the lease.
  const conditionalWrites = await driver.probeConditionalWrites();
  if (!conditionalWrites) {
    throw new LeaseUnsupportedError(
      "the storage backend does not support conditional writes; the instance lease cannot be exclusive",
    );
  }

  const current = await driver.readVersioned(key);
  const currentLease = current ? parseLease(new TextDecoder().decode(current.data)) : null;

  if (currentLease && Date.parse(currentLease.expiresAt) > now()) {
    throw new LeaseConflictError(currentLease.holderId, currentLease.expiresAt);
  }

  const epoch = (currentLease?.epoch ?? 0) + 1;
  const result = await driver.compareAndSwap(
    key,
    JSON.stringify(buildPayload(epoch)),
    current?.version ?? null,
  );
  if (result === "unsupported") {
    throw new LeaseUnsupportedError(
      `the storage backend cannot perform conditional writes; the instance lease cannot be exclusive (key=${key})`,
    );
  }
  if (result === "conflict") {
    // Another instance won the race. Report whoever holds it now.
    const winner = await driver.readVersioned(key);
    const winnerLease = winner ? parseLease(new TextDecoder().decode(winner.data)) : null;
    throw new LeaseConflictError(
      winnerLease?.holderId ?? "unknown",
      winnerLease?.expiresAt ?? new Date(now()).toISOString(),
    );
  }

  let expiresAtMs = now() + ttlMs;
  let token = "";
  let released = false;

  const readOwned = async (): Promise<{ lease: LeasePayload; version: string | null } | null> => {
    const stored = await driver.readVersioned(key);
    if (!stored) {
      return null;
    }
    const lease = parseLease(new TextDecoder().decode(stored.data));
    if (!lease || lease.holderId !== holderId || lease.token !== token) {
      return null;
    }
    return { lease, version: stored.version };
  };

  const renew = async (): Promise<void> => {
    const owned = await readOwned();
    if (!owned) {
      const stored = await driver.readVersioned(key);
      const lease = stored ? parseLease(new TextDecoder().decode(stored.data)) : null;
      throw new LeaseLostError(lease?.holderId ?? "unknown");
    }
    const payload = buildPayload(owned.lease.epoch);
    const swap = await driver.compareAndSwap(key, JSON.stringify(payload), owned.version ?? null);
    if (swap === "unsupported") {
      throw new LeaseUnsupportedError(
        "the storage backend cannot perform conditional writes; the lease cannot be renewed safely",
      );
    }
    if (swap === "conflict") {
      throw new LeaseLostError("unknown");
    }
    token = payload.token;
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
      const owned = await readOwned();
      if (!owned) {
        // Somebody else owns the term now — never touch it.
        return;
      }
      // Expire the term instead of deleting the object: a delete could
      // remove a lease another instance acquired in the meantime.
      const expired = {
        ...owned.lease,
        expiresAt: new Date(now()).toISOString(),
      };
      await driver.compareAndSwap(key, JSON.stringify(expired), owned.version ?? null);
    } catch {
      // Releasing is best effort: the term expires on its own.
    }
  };

  // Read back the term we just wrote so the token matches what is stored.
  const stored = await driver.readVersioned(key);
  const storedLease = stored ? parseLease(new TextDecoder().decode(stored.data)) : null;
  token = storedLease?.token ?? "";

  return {
    epoch,
    expiresAtMs,
    holderId,
    key,
    release,
    renew,
  };
}

/**
 * Probe whether the backend honours conditional writes.
 *
 * The lease's exclusivity depends on it, so the answer decides whether the
 * bot may start at all. The probe object is removed afterwards.
 */
export async function probeConditionalWriteSupport(driver: StorageDriver): Promise<boolean> {
  return driver.probeConditionalWrites();
}
