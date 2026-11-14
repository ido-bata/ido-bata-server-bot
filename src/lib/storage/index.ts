/**
 * Storage backend selection.
 *
 * `STORAGE_BACKEND` picks the adapter:
 *
 * - `local` (default) — files under `DATA_DIR` (default `<cwd>/data`). This
 *   is the behaviour of the original single-host deployment.
 * - `u3` — S3-compatible object storage (Altare U3). On Altare the
 *   "Connect to app" flow injects `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET`
 *   / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`; the `U3_*` aliases are
 *   accepted for operators who prefer them.
 * - `valkey` — Redis-compatible store (Altare Valkey). U3 does not
 *   implement S3 conditional writes, so the instance lease uses this
 *   backend (`LEASE_STORAGE_BACKEND=valkey`, `REDIS_URL` injected by
 *   `altr valkey attach`).
 *
 * The instance lease uses its own configuration (`LEASE_STORAGE_BACKEND` and
 * the `LEASE_*` overrides). During a migration cutover the old host must
 * contend for the *same* lease object as the new deployment even while its
 * data still lives on the local disk — a lease inside the local `data/`
 * directory would be invisible to the Altare instance and would not
 * prevent a double run.
 *
 * See ADR-0004 for why object storage — not the app's local disk — is the
 * source of truth on Altare.
 */

import { readFileSync } from "node:fs";

import { createLocalFileStorage } from "./local.js";
import type { StorageDriver } from "./types.js";
import { createU3Storage } from "./u3.js";
import { createValkeyStorage } from "./valkey.js";

export type { StorageDriver } from "./types.js";

export type LocalStorageConfig = {
  backend: "local";
  /** Directory that holds the storage root. */
  root: string;
};

export type U3StorageConfig = {
  backend: "u3";
  accessKeyId: string;
  bucket: string;
  endpoint?: string;
  prefix?: string;
  region?: string;
  secretAccessKey: string;
  sessionToken?: string;
};

export type ValkeyStorageConfig = {
  backend: "valkey";
  /** Connection URL (`redis://` / `rediss://`). */
  url: string;
  /** Key prefix inside the keyspace. */
  prefix?: string;
  /** PEM CA for `rediss://` verification (Altare: the instance certificate). */
  tlsCa?: string;
  /** Explicit opt-out of `rediss://` certificate verification (insecure). */
  tlsInsecure?: boolean;
};

export type StorageConfig = LocalStorageConfig | U3StorageConfig | ValkeyStorageConfig;

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

/**
 * Parse the storage configuration from an environment. Throws when the
 * selected backend is missing required settings — a misconfigured deployment
 * must fail at startup, not silently fall back to a local disk that a
 * redeploy would wipe.
 */
export function readStorageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const backend = (firstNonEmpty(env.STORAGE_BACKEND) ?? "local").toLowerCase();

  if (backend === "local") {
    return {
      backend: "local",
      root: firstNonEmpty(env.DATA_DIR) ?? `${process.cwd()}/data`,
    };
  }

  if (backend === "u3") {
    const bucket = firstNonEmpty(env.S3_BUCKET, env.U3_BUCKET);
    const accessKeyId = firstNonEmpty(env.AWS_ACCESS_KEY_ID, env.U3_ACCESS_KEY_ID);
    const secretAccessKey = firstNonEmpty(env.AWS_SECRET_ACCESS_KEY, env.U3_SECRET_ACCESS_KEY);
    if (!bucket) {
      throw new Error("storage backend 'u3' requires S3_BUCKET (or U3_BUCKET)");
    }
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        "storage backend 'u3' requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (or the U3_* aliases)",
      );
    }
    return {
      accessKeyId,
      backend: "u3",
      bucket,
      endpoint: firstNonEmpty(env.S3_ENDPOINT, env.U3_ENDPOINT),
      prefix: firstNonEmpty(env.S3_PREFIX, env.U3_PREFIX),
      region: firstNonEmpty(env.S3_REGION, env.U3_REGION),
      secretAccessKey,
      sessionToken: firstNonEmpty(env.AWS_SESSION_TOKEN, env.U3_SESSION_TOKEN),
    };
  }

  if (backend === "valkey") {
    const url = firstNonEmpty(env.VALKEY_URL, env.REDIS_URL);
    if (!url) {
      throw new Error("storage backend 'valkey' requires VALKEY_URL (or REDIS_URL)");
    }
    return {
      backend: "valkey",
      prefix: firstNonEmpty(env.VALKEY_PREFIX),
      url,
      ...readValkeyTlsConfig(env),
    };
  }

  throw new Error(`unknown STORAGE_BACKEND: ${backend} (expected "local", "u3" or "valkey")`);
}

/**
 * Parse the lease configuration. It defaults to the data configuration, so
 * a deployment that does not care about the cutover needs no extra
 * variables.
 */
export function readLeaseConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const leaseBackend = firstNonEmpty(env.LEASE_STORAGE_BACKEND);
  if (!leaseBackend) {
    return readStorageConfig(env);
  }
  const backend = leaseBackend.toLowerCase();
  if (backend === "local") {
    return {
      backend: "local",
      root:
        firstNonEmpty(env.LEASE_DATA_DIR) ?? firstNonEmpty(env.DATA_DIR) ?? `${process.cwd()}/data`,
    };
  }
  if (backend === "u3") {
    const bucket = firstNonEmpty(
      env.LEASE_S3_BUCKET,
      env.LEASE_U3_BUCKET,
      env.S3_BUCKET,
      env.U3_BUCKET,
    );
    const accessKeyId = firstNonEmpty(
      env.LEASE_AWS_ACCESS_KEY_ID,
      env.LEASE_U3_ACCESS_KEY_ID,
      env.AWS_ACCESS_KEY_ID,
      env.U3_ACCESS_KEY_ID,
    );
    const secretAccessKey = firstNonEmpty(
      env.LEASE_AWS_SECRET_ACCESS_KEY,
      env.LEASE_U3_SECRET_ACCESS_KEY,
      env.AWS_SECRET_ACCESS_KEY,
      env.U3_SECRET_ACCESS_KEY,
    );
    if (!bucket) {
      throw new Error("lease backend 'u3' requires LEASE_S3_BUCKET (or S3_BUCKET)");
    }
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        "lease backend 'u3' requires LEASE_AWS_ACCESS_KEY_ID and LEASE_AWS_SECRET_ACCESS_KEY (or the S3_* fallbacks)",
      );
    }
    return {
      accessKeyId,
      backend: "u3",
      bucket,
      endpoint: firstNonEmpty(
        env.LEASE_S3_ENDPOINT,
        env.LEASE_U3_ENDPOINT,
        env.S3_ENDPOINT,
        env.U3_ENDPOINT,
      ),
      prefix: firstNonEmpty(env.LEASE_S3_PREFIX, env.LEASE_U3_PREFIX, env.S3_PREFIX, env.U3_PREFIX),
      region: firstNonEmpty(env.LEASE_S3_REGION, env.LEASE_U3_REGION, env.S3_REGION, env.U3_REGION),
      secretAccessKey,
      sessionToken: firstNonEmpty(
        env.LEASE_AWS_SESSION_TOKEN,
        env.LEASE_U3_SESSION_TOKEN,
        env.AWS_SESSION_TOKEN,
        env.U3_SESSION_TOKEN,
      ),
    };
  }
  if (backend === "valkey") {
    const url = firstNonEmpty(
      env.LEASE_VALKEY_URL,
      env.LEASE_REDIS_URL,
      env.VALKEY_URL,
      env.REDIS_URL,
    );
    if (!url) {
      throw new Error(
        "lease backend 'valkey' requires LEASE_VALKEY_URL (or VALKEY_URL / REDIS_URL)",
      );
    }
    return {
      backend: "valkey",
      prefix: firstNonEmpty(env.LEASE_VALKEY_PREFIX, env.VALKEY_PREFIX),
      url,
      ...readValkeyTlsConfig(env, "LEASE_"),
    };
  }
  throw new Error(`unknown LEASE_STORAGE_BACKEND: ${backend} (expected "local", "u3" or "valkey")`);
}

/**
 * Resolve the `rediss://` TLS options for a valkey backend.
 *
 * `*_TLS_CA` carries the PEM inline (literal `\n` sequences are
 * unescaped, so a single-line env var works); `*_TLS_CA_FILE` reads it
 * from a path instead. `*_TLS_INSECURE=true` is the explicit opt-out —
 * without a CA and without the flag, certificate verification stays on
 * and a self-signed endpoint fails closed. Lease-scoped variables win
 * over the shared ones.
 */
function readValkeyTlsConfig(
  env: NodeJS.ProcessEnv,
  leasePrefix = "",
): { tlsCa?: string; tlsInsecure?: boolean } {
  const names = (suffix: string) =>
    firstNonEmpty(
      leasePrefix ? env[`${leasePrefix}VALKEY_TLS_${suffix}`] : undefined,
      env[`VALKEY_TLS_${suffix}`],
      env[`REDIS_TLS_${suffix}`],
    );
  const caFile = names("CA_FILE");
  const caInline = names("CA");
  const tlsCa = caFile ? readFileSync(caFile, "utf8") : caInline?.replace(/\\n/g, "\n");
  const insecure = firstNonEmpty(
    leasePrefix ? env[`${leasePrefix}VALKEY_TLS_INSECURE`] : undefined,
    env.VALKEY_TLS_INSECURE,
    env.REDIS_TLS_INSECURE,
  );
  return {
    ...(tlsCa ? { tlsCa } : {}),
    ...(insecure === "true" || insecure === "1" ? { tlsInsecure: true } : {}),
  };
}

/** Build the storage driver described by `config`. */
export function createStorageDriverFromConfig(config: StorageConfig): StorageDriver {
  if (config.backend === "local") {
    return createLocalFileStorage({ root: config.root });
  }
  if (config.backend === "valkey") {
    return createValkeyStorage({
      prefix: config.prefix,
      tlsCa: config.tlsCa,
      tlsInsecure: config.tlsInsecure,
      url: config.url,
    });
  }
  return createU3Storage({
    accessKeyId: config.accessKeyId,
    bucket: config.bucket,
    endpoint: config.endpoint,
    forcePathStyle: true,
    prefix: config.prefix,
    region: config.region,
    secretAccessKey: config.secretAccessKey,
    sessionToken: config.sessionToken,
  });
}

/** Build the storage driver described by an environment. */
export function createStorageDriver(env: NodeJS.ProcessEnv = process.env): StorageDriver {
  return createStorageDriverFromConfig(readStorageConfig(env));
}

/**
 * Build the driver that holds the instance lease. It is configured
 * independently of the data backend so that two hosts can contend for the
 * same lease during a cutover.
 */
export function createLeaseDriver(env: NodeJS.ProcessEnv = process.env): StorageDriver {
  return createStorageDriverFromConfig(readLeaseConfig(env));
}

let activeDriver: StorageDriver | null = null;
let activeLeaseDriver: StorageDriver | null = null;

/**
 * The process-wide storage driver. Created lazily from the environment so
 * that importing a feature module never requires storage configuration.
 */
export function getStorageDriver(): StorageDriver {
  if (!activeDriver) {
    activeDriver = createStorageDriver();
  }
  return activeDriver;
}

/** Override the process-wide driver (tests, migration tooling). */
export function setStorageDriver(driver: StorageDriver | null): void {
  activeDriver = driver;
}

/** The driver that holds the instance lease. */
export function getLeaseDriver(): StorageDriver {
  if (!activeLeaseDriver) {
    activeLeaseDriver = createLeaseDriver();
  }
  return activeLeaseDriver;
}
