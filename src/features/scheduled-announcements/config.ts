import { basename, dirname } from "node:path";

import { z } from "zod";

import { getStorageDriver } from "../../lib/storage/index.js";
import { STORAGE_KEYS } from "../../lib/storage/keys.js";
import { createLocalFileStorage } from "../../lib/storage/local.js";
import type { StorageDriver } from "../../lib/storage/types.js";

const JST_OFFSET_MINUTES = 9 * 60;

const entrySchema = z
  .object({
    id: z.string().min(1),
    channelId: z.string().min(1),
    message: z.string().min(1),
    weekday: z.number().int().min(0).max(6).optional(),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    oneShotDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "oneShotDate must be YYYY-MM-DD")
      .optional(),
    enabled: z.boolean(),
  })
  .refine(
    (entry) =>
      // Exactly one of weekday or oneShotDate must be present so the scheduler
      // has a clear cadence to evaluate.
      (entry.weekday !== undefined) !== (entry.oneShotDate !== undefined),
    { message: "Each entry needs exactly one of weekday or oneShotDate" },
  );

export const scheduledAnnouncementsFileSchema = z.object({
  entries: z.array(entrySchema),
});

export type ScheduledAnnouncementEntry = z.infer<typeof entrySchema>;

export type LoadOptions = {
  /**
   * Override the filesystem path. Tests inject a temp file here; the
   * store is then served by a local filesystem driver rooted at its
   * directory.
   */
  filePath?: string;
  /** Storage backend holding the cadence configuration. */
  driver?: StorageDriver;
  /** Storage key of the cadence configuration. */
  key?: string;
};

export type LoadResult = {
  entries: ScheduledAnnouncementEntry[];
  /** Storage key of the cadence configuration. */
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
    key: options.key ?? STORAGE_KEYS.scheduledAnnouncements,
  };
}

export async function loadScheduledAnnouncements(options: LoadOptions = {}): Promise<LoadResult> {
  const { driver, key } = resolveStore(options);
  const raw = await driver.readText(key);
  if (raw === null) {
    return { entries: [], key };
  }

  const parsed = scheduledAnnouncementsFileSchema.parse(JSON.parse(raw));
  return { entries: parsed.entries, key };
}

export async function saveScheduledAnnouncements(
  entries: ScheduledAnnouncementEntry[],
  options: LoadOptions = {},
): Promise<string> {
  const { driver, key } = resolveStore(options);
  const payload = { entries };
  await driver.write(key, `${JSON.stringify(payload, null, 2)}\n`);
  return key;
}

export function getJstOffsetMinutes(): number {
  return JST_OFFSET_MINUTES;
}
