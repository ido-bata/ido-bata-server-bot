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
 *
 * See ADR-0004 for why object storage — not the app's local disk — is the
 * source of truth on Altare.
 */

import { createLocalFileStorage } from "./local.js";
import type { StorageDriver } from "./types.js";
import { createU3Storage } from "./u3.js";

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

export type StorageConfig = LocalStorageConfig | U3StorageConfig;

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

  throw new Error(`unknown STORAGE_BACKEND: ${backend} (expected "local" or "u3")`);
}

/** Build the storage driver described by `config`. */
export function createStorageDriverFromConfig(config: StorageConfig): StorageDriver {
  if (config.backend === "local") {
    return createLocalFileStorage({ root: config.root });
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

let activeDriver: StorageDriver | null = null;

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
