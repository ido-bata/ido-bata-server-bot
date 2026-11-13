/**
 * Per-consumer delete adapter for the timekeeper attendance history.
 *
 * Removes the user's entry from `data/timekeeper-history.json` if present.
 * Failures (read / parse / schema / write errors) are surfaced via
 * `{ ok: false, error }` so the aggregator (`src/features/privacy/clear.ts`)
 * can report a partial failure to `/privacy delete` instead of declaring
 * success on a corrupted store.
 */
import { basename, dirname } from "node:path";
import { z } from "zod";
import { getStorageDriver } from "../../../lib/storage/index.js";
import { mutateJsonObject } from "../../../lib/storage/json.js";
import { STORAGE_KEYS } from "../../../lib/storage/keys.js";
import { createLocalFileStorage } from "../../../lib/storage/local.js";
import type { StorageDriver } from "../../../lib/storage/types.js";
import type { DeleteResult } from "../types.js";

export type TimekeeperDeleteOptions = {
  /**
   * Legacy filesystem path. Kept for operators and tests that pin the
   * store to one file; the store is then served by a local filesystem
   * driver rooted at its directory.
   */
  filePath?: string;
  /** Storage backend holding the store. */
  driver?: StorageDriver;
  /** Storage key of the store. Defaults to the canonical key. */
  key?: string;
};

const historySchema = z.record(z.string(), z.array(z.string()));

function resolveStore(options: TimekeeperDeleteOptions): { driver: StorageDriver; key: string } {
  if (options.filePath) {
    return {
      driver: createLocalFileStorage({ root: dirname(options.filePath) }),
      key: basename(options.filePath),
    };
  }
  return {
    driver: options.driver ?? getStorageDriver(),
    key: options.key ?? STORAGE_KEYS.timekeeperHistory,
  };
}

export function deleteUserData(
  userId: string,
  options: TimekeeperDeleteOptions = {},
): Promise<DeleteResult> {
  return runDelete(userId, options);
}

async function runDelete(userId: string, options: TimekeeperDeleteOptions): Promise<DeleteResult> {
  const { driver, key } = resolveStore(options);
  const outcome = await mutateJsonObject({
    driver,
    key,
    mutate: (current) => {
      if (!(userId in current)) {
        // Returning the same reference signals "no change" — the
        // helper skips the write so we do not touch mtime on disk
        // for users with nothing to remove.
        return current;
      }
      const next = { ...current };
      delete next[userId];
      return next;
    },
    schema: historySchema,
  });

  if (!outcome.ok) {
    return { ok: false, error: outcome.error };
  }
  return { ok: true };
}
