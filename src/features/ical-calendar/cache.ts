import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

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

export function loadCache(cachePath: string): CalendarCache {
  if (!existsSync(cachePath)) {
    return { sources: [] };
  }
  try {
    const raw = readFileSync(cachePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isCalendarCache(parsed)) {
      return { sources: [] };
    }
    return reviveDates(parsed);
  } catch {
    return { sources: [] };
  }
}

export function saveCache(cachePath: string, cache: CalendarCache): void {
  const dir = dirname(cachePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // Write atomically: serialise to a uniquely-named temp file via O_EXCL, then rename
  // it onto the final path. This avoids symlink TOCTOU attacks even when cachePath lives
  // in a shared directory such as /tmp.
  const payload = `${JSON.stringify(cache, null, 2)}\n`;
  const tempPath = `${cachePath}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(tempPath, "wx", 0o600);
  try {
    writeFileSync(fd, payload, "utf8");
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tempPath, cachePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
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
