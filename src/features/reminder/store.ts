import { basename, dirname } from "node:path";

import { z } from "zod";

import { getStorageDriver } from "../../lib/storage/index.js";
import { STORAGE_KEYS } from "../../lib/storage/keys.js";
import { createLocalFileStorage } from "../../lib/storage/local.js";
import type { StorageDriver } from "../../lib/storage/types.js";

const reminderSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  message: z.string().min(1),
  // ISO 8601 string. We store as ISO so the persisted JSON is diff-stable
  // across runs and round-trips cleanly through `JSON.parse`.
  fireAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true }),
});

const storeSchema = z.object({
  reminders: z.array(reminderSchema),
});

export type PersistedReminder = z.infer<typeof reminderSchema>;

export type LoadOptions = {
  /**
   * Override the filesystem path. Tests inject a temp file here; the
   * store is then served by a local filesystem driver rooted at its
   * directory.
   */
  filePath?: string;
  /** Storage backend holding the reminders. */
  driver?: StorageDriver;
  /** Storage key of the reminder list. */
  key?: string;
};

export type LoadResult = {
  reminders: PersistedReminder[];
  /** Storage key of the reminder list. */
  key: string;
};

function resolveStore(options: LoadOptions): { driver: StorageDriver; key: string } {
  if (options.filePath) {
    return {
      driver: createLocalFileStorage({ root: dirname(options.filePath) }),
      key: basename(options.filePath),
    };
  }
  return {
    driver: options.driver ?? getStorageDriver(),
    key: options.key ?? STORAGE_KEYS.reminders,
  };
}

export async function loadReminders(options: LoadOptions = {}): Promise<LoadResult> {
  const { driver, key } = resolveStore(options);

  const raw = await driver.readText(key);
  if (raw === null) {
    return { key, reminders: [] };
  }

  // Defensive: treat unreadable / malformed JSON as an empty store so a
  // corrupted object doesn't crash the bot on boot (matches the timekeeper
  // history pattern from `features/timekeeper/engagement.ts`).
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { key, reminders: [] };
  }
  const parsed = storeSchema.safeParse(payload);
  if (!parsed.success) {
    return { key, reminders: [] };
  }

  return { key, reminders: parsed.data.reminders };
}

export async function saveReminders(
  reminders: readonly PersistedReminder[],
  options: LoadOptions = {},
): Promise<string> {
  const { driver, key } = resolveStore(options);
  const payload = { reminders: [...reminders] };
  await driver.write(key, `${JSON.stringify(payload, null, 2)}\n`);
  return key;
}
