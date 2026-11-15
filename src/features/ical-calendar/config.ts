import { z } from "zod";

import { getStorageDriver } from "../../lib/storage/index.js";
import { STORAGE_KEYS } from "../../lib/storage/keys.js";
import type { StorageDriver } from "../../lib/storage/types.js";

export type CalendarSource = {
  id: string;
  name: string;
  url: string;
};

export type IcalCalendarConfig = {
  announcementChannelId: string | null;
  /** Storage key of the calendar cache. */
  cacheKey: string;
  /** Storage key of the calendar source configuration. */
  dataKey: string;
  fetchIntervalMs: number;
  lookAheadDays: number;
  rateLimitMs: number;
  sources: CalendarSource[];
  staleAfterMs: number;
};

const DEFAULT_ANNOUNCEMENT_CHANNEL_ID: string | null = null;
const DEFAULT_FETCH_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_LOOK_AHEAD_DAYS = 7;
const DEFAULT_RATE_LIMIT_MS = 60_000;
const DEFAULT_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

const calendarSourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().url(),
});

const persistedSchema = z.object({
  announcementChannelId: z.string().nullable().optional(),
  lookAheadDays: z.number().int().positive().optional(),
  sources: z.array(calendarSourceSchema).optional(),
});

type PersistedShape = z.infer<typeof persistedSchema>;

async function readPersisted(driver: StorageDriver, key: string): Promise<PersistedShape> {
  try {
    const raw = await driver.readText(key);
    if (raw === null) {
      return {};
    }
    const json: unknown = JSON.parse(raw);
    return persistedSchema.parse(json);
  } catch {
    return {};
  }
}

/**
 * Read the calendar configuration from the storage backend (ADR-0004):
 * the local `data/calendars.json` file on a single host, the
 * `calendars.json` object in the bucket on Altare.
 */
export async function readConfig(
  options: { driver?: StorageDriver; key?: string } = {},
): Promise<IcalCalendarConfig> {
  const driver = options.driver ?? getStorageDriver();
  const dataKey = options.key ?? "calendars.json";
  const persisted = await readPersisted(driver, dataKey);

  return {
    announcementChannelId: persisted.announcementChannelId ?? DEFAULT_ANNOUNCEMENT_CHANNEL_ID,
    cacheKey: STORAGE_KEYS.calendarCache,
    dataKey,
    fetchIntervalMs: DEFAULT_FETCH_INTERVAL_MS,
    lookAheadDays: persisted.lookAheadDays ?? DEFAULT_LOOK_AHEAD_DAYS,
    rateLimitMs: DEFAULT_RATE_LIMIT_MS,
    sources: persisted.sources ?? [],
    staleAfterMs: DEFAULT_STALE_AFTER_MS,
  };
}

export function findSource(sources: CalendarSource[], id: string): CalendarSource | null {
  return sources.find((source) => source.id === id) ?? null;
}
