/**
 * Resolve "where does this store live" in one place.
 *
 * Every feature store can be pinned three ways:
 *
 * - `filePath` — one file on the local filesystem (tests, operators who
 *   want the store next to the process). The file is served by a local
 *   driver rooted at its directory.
 * - `driver` + `key` — an explicit backend and storage key.
 * - neither — the process-wide driver and the caller's default key.
 */

import { basename, dirname } from "node:path";
import { getStorageDriver } from "./index.js";
import { createLocalFileStorage } from "./local.js";
import type { StorageDriver } from "./types.js";

export type StorageTargetOptions = {
  /** Legacy filesystem path. */
  filePath?: string;
  /** Storage backend. */
  driver?: StorageDriver;
  /** Storage key. */
  key?: string;
  /** Storage key used when neither `filePath` nor `key` is given. */
  defaultKey: string;
};

export type StorageTarget = {
  driver: StorageDriver;
  key: string;
};

export function resolveStorageTarget(options: StorageTargetOptions): StorageTarget {
  if (options.filePath) {
    return {
      driver: createLocalFileStorage({ root: dirname(options.filePath) }),
      key: basename(options.filePath),
    };
  }
  return {
    driver: options.driver ?? getStorageDriver(),
    key: options.key ?? options.defaultKey,
  };
}
