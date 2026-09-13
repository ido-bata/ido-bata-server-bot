import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export type CalendarSource = {
  id: string;
  name: string;
  url: string;
};

export type IcalCalendarConfig = {
  announcementChannelId: string | null;
  cachePath: string;
  dataPath: string;
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

function resolveDataPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "data", "calendars.json");
}

function readPersisted(path: string): PersistedShape {
  try {
    const raw = readFileSync(path, "utf8");
    const json: unknown = JSON.parse(raw);
    return persistedSchema.parse(json);
  } catch {
    return {};
  }
}

export function readConfig(path?: string): IcalCalendarConfig {
  const dataPath = path ?? resolveDataPath();
  const persisted = readPersisted(dataPath);

  return {
    announcementChannelId: persisted.announcementChannelId ?? DEFAULT_ANNOUNCEMENT_CHANNEL_ID,
    cachePath: join(dirname(dataPath), "calendar-cache.json"),
    dataPath,
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
