import { getStorageDriver } from "../../lib/storage/index.js";
import { STORAGE_KEYS } from "../../lib/storage/keys.js";
import type { StorageDriver } from "../../lib/storage/types.js";
import type { CalendarCache, CalendarEvent, SourceCalendarEntry } from "./types.js";

const cacheSchemaShape = {
  sources: true,
} as const;

function isCalendarCache(value: unknown): value is CalendarCache {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { sources?: unknown };
  if (!Array.isArray(candidate.sources)) {
    return false;
  }
  return candidate.sources.every((entry) => isSourceEntry(entry));
}

function isSourceEntry(value: unknown): value is SourceCalendarEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as { events?: unknown; fetchedAt?: unknown; sourceId?: unknown };
  return (
    typeof entry.sourceId === "string" &&
    typeof entry.fetchedAt === "string" &&
    Array.isArray(entry.events)
  );
}

export async function loadCache(
  driver: StorageDriver = getStorageDriver(),
  key: string = STORAGE_KEYS.calendarCache,
): Promise<CalendarCache> {
  try {
    const raw = await driver.readText(key);
    if (raw === null) {
      return { sources: [] };
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isCalendarCache(parsed)) {
      return { sources: [] };
    }
    return reviveDates(parsed);
  } catch {
    return { sources: [] };
  }
}

export async function saveCache(
  cache: CalendarCache,
  driver: StorageDriver = getStorageDriver(),
  key: string = STORAGE_KEYS.calendarCache,
): Promise<void> {
  // The storage backend publishes the new object atomically, so a reader
  // never observes a half-written cache.
  await driver.write(key, `${JSON.stringify(cache, null, 2)}\n`);
}

export function upsertSourceEntry(cache: CalendarCache, entry: SourceCalendarEntry): CalendarCache {
  const next = cache.sources.filter((existing) => existing.sourceId !== entry.sourceId);
  next.push(entry);
  next.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  return { sources: next };
}

export function mergeSourceEvents(
  cache: CalendarCache,
  sourceId: string,
  events: CalendarEvent[],
  fetchedAt: string,
): CalendarCache {
  return upsertSourceEntry(cache, { events, fetchedAt, sourceId });
}

export function isStale(
  entry: { fetchedAt: string },
  staleAfterMs: number,
  now: Date = new Date(),
): boolean {
  const fetchedAtMs = Date.parse(entry.fetchedAt);
  if (Number.isNaN(fetchedAtMs)) {
    return true;
  }
  return now.getTime() - fetchedAtMs > staleAfterMs;
}

function reviveDates(cache: CalendarCache): CalendarCache {
  for (const entry of cache.sources) {
    for (const event of entry.events) {
      event.startAt = new Date(event.startAt);
      event.endAt = event.endAt ? new Date(event.endAt) : null;
    }
  }
  return cache;
}

// Suppress unused-binding warning for cache schema shape used only for type assertions.
void cacheSchemaShape;
