/**
 * Per-consumer delete adapter for the reminder feature.
 *
 * Removes every reminder where `userId` matches from `data/reminders.json`.
 * Failures (read / parse / schema / write) surface as `{ ok: false, error }`
 * — ENOENT (no persisted file) is treated as success, since there is
 * nothing to remove.
 */
import { z } from "zod";
import { mutateJsonObject } from "../../../lib/storage/json.js";
import { STORAGE_KEYS } from "../../../lib/storage/keys.js";
import { resolveStorageTarget } from "../../../lib/storage/target.js";
import type { StorageDriver } from "../../../lib/storage/types.js";
import type { DeleteResult } from "../types.js";

export type ReminderDeleteOptions = {
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
  id: z.string(),
  userId: z.string(),
  message: z.string(),
  fireAt: z.string(),
  createdAt: z.string(),
});

const storeSchema = z.object({
  reminders: z.array(entrySchema),
});

export function deleteUserData(
  userId: string,
  options: ReminderDeleteOptions = {},
): Promise<DeleteResult> {
  return runDelete(userId, options);
}

async function runDelete(userId: string, options: ReminderDeleteOptions): Promise<DeleteResult> {
  const { driver, key } = resolveStorageTarget({
    defaultKey: STORAGE_KEYS.reminders,
    driver: options.driver,
    filePath: options.filePath,
    key: options.key,
  });
  const outcome = await mutateJsonObject({
    driver,
    key,
    mutate: (current) => {
      const filtered = current.reminders.filter((reminder) => reminder.userId !== userId);
      if (filtered.length === current.reminders.length) {
        return current;
      }
      return { reminders: filtered };
    },
    schema: storeSchema,
  });

  if (!outcome.ok) {
    return { ok: false, error: outcome.error };
  }
  return { ok: true };
}
