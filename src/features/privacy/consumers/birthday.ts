/**
 * Per-consumer delete adapter for the birthday-role feature.
 *
 * Removes the user's entry from `data/birthdays.json` if present. Mirrors
 * the `timekeeper` adapter: failures (read / parse / schema / write) are
 * surfaced as `{ ok: false, error }` so the aggregator can report a
 * partial failure. ENOENT (no persisted file) is treated as success —
 * there is nothing to remove.
 */
import { z } from "zod";
import { mutateJsonObject } from "../../../lib/storage/json.js";
import { STORAGE_KEYS } from "../../../lib/storage/keys.js";
import { resolveStorageTarget } from "../../../lib/storage/target.js";
import type { StorageDriver } from "../../../lib/storage/types.js";
import type { DeleteResult } from "../types.js";

export type BirthdayDeleteOptions = {
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

const entrySchema = z.object({
  date: z.string(),
  updatedAt: z.string(),
  userId: z.string(),
});

const storeSchema = z.object({
  birthdays: z.record(z.string(), entrySchema),
});

export function deleteUserData(
  userId: string,
  options: BirthdayDeleteOptions = {},
): Promise<DeleteResult> {
  return runDelete(userId, options);
}

async function runDelete(userId: string, options: BirthdayDeleteOptions): Promise<DeleteResult> {
  const { driver, key } = resolveStorageTarget({
    defaultKey: STORAGE_KEYS.birthdays,
    driver: options.driver,
    filePath: options.filePath,
    key: options.key,
  });
  const outcome = await mutateJsonObject({
    driver,
    key,
    mutate: (current) => {
      if (!(userId in current.birthdays)) {
        return current;
      }
      const nextBirthdays = { ...current.birthdays };
      delete nextBirthdays[userId];
      return { birthdays: nextBirthdays };
    },
    schema: storeSchema,
  });

  if (!outcome.ok) {
    return { ok: false, error: outcome.error };
  }
  return { ok: true };
}
