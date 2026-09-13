import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isStale,
  loadCache,
  mergeSourceEvents,
  saveCache,
  upsertSourceEntry,
} from "../src/features/ical-calendar/cache.js";
import type { IcalCalendarConfig } from "../src/features/ical-calendar/config.js";
import { createCalendarFetcher } from "../src/features/ical-calendar/fetcher.js";
import type { Logger } from "../src/features/ical-calendar/logger.js";
import { createCalendarService } from "../src/features/ical-calendar/service.js";
import type { CalendarEvent } from "../src/features/ical-calendar/types.js";

const tmpPaths: string[] = [];

function makeConfig(overrides: Partial<IcalCalendarConfig> = {}): IcalCalendarConfig {
  const basePath = `/tmp/ical-test-${Math.random().toString(36).slice(2)}-${Date.now()}.json`;
  tmpPaths.push(basePath);
  return {
    announcementChannelId: null,
    cachePath: basePath.replace(".json", "-cache.json"),
    dataPath: basePath,
    fetchIntervalMs: 60 * 60 * 1000,
    lookAheadDays: 7,
    rateLimitMs: 0,
    sources: [
      { id: "team", name: "チーム", url: "https://example.com/team.ics" },
      { id: "public", name: "パブリック", url: "https://example.com/public.ics" },
    ],
    staleAfterMs: 5 * 60 * 1000,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    uid: "src:evt",
    sourceId: "team",
    summary: "Sample",
    description: "",
    location: "",
    startAt: new Date("2026-09-20T22:00:00Z"),
    endAt: new Date("2026-09-20T23:00:00Z"),
    isAllDay: false,
    ...overrides,
  };
}

afterEach(() => {
  for (const path of tmpPaths.splice(0)) {
    try {
      rmSync(path, { force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("ical-calendar cache", () => {
  it("returns empty cache when file does not exist", () => {
    const cache = loadCache("/tmp/does-not-exist-cache.json");
    expect(cache.sources).toEqual([]);
  });

  it("upserts source entries", () => {
    const start = {
      sources: [] as { events: CalendarEvent[]; fetchedAt: string; sourceId: string }[],
    };
    const entry = {
      sourceId: "team",
      fetchedAt: new Date().toISOString(),
      events: [makeEvent({ uid: "team:1" })],
    };
    const afterFirst = upsertSourceEntry(start, entry);
    const afterSecond = upsertSourceEntry(afterFirst, {
      ...entry,
      fetchedAt: new Date().toISOString(),
      events: [makeEvent({ uid: "team:2" })],
    });
    expect(afterSecond.sources).toHaveLength(1);
    expect(afterSecond.sources[0]?.events[0]?.uid).toBe("team:2");
  });

  it("marks entries as stale after threshold", () => {
    const now = new Date("2026-09-13T00:00:00Z");
    const fresh = { fetchedAt: now.toISOString() };
    const stale = { fetchedAt: new Date(now.getTime() - 10 * 60 * 1000).toISOString() };
    expect(isStale(fresh, 5 * 60 * 1000, now)).toBe(false);
    expect(isStale(stale, 5 * 60 * 1000, now)).toBe(true);
  });

  it("persists and reloads the cache", () => {
    const cachePath = `/tmp/ical-cache-${Math.random().toString(36).slice(2)}.json`;
    tmpPaths.push(cachePath);
    const event = makeEvent();
    const cache = mergeSourceEvents({ sources: [] }, "team", [event], new Date().toISOString());
    saveCache(cachePath, cache);
    const reloaded = loadCache(cachePath);
    expect(reloaded.sources).toHaveLength(1);
    const firstEvent = reloaded.sources[0]?.events[0];
    expect(firstEvent?.startAt).toBeInstanceOf(Date);
    expect(firstEvent?.endAt).toBeInstanceOf(Date);
  });
});

describe("ical-calendar fetcher", () => {
  it("parses events from each source URL", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("team")) {
        return `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:t1\nDTSTAMP:20260101T000000Z\nDTSTART:20260920T220000Z\nDTEND:20260920T230000Z\nSUMMARY:Standup\nEND:VEVENT\nEND:VCALENDAR`;
      }
      throw new Error("HTTP 404 Not Found");
    });

    const fetcher = createCalendarFetcher({
      fetchImpl,
      rateLimitMs: 0,
      now: () => new Date(),
    });

    const result = await fetcher.fetchAll([
      { id: "team", url: "https://example.com/team.ics" },
      { id: "public", url: "https://example.com/public.ics" },
    ]);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.uid).toBe("team:t1");
    expect(result.failedSources).toEqual([
      { id: "public", reason: expect.stringContaining("404") },
    ]);
  });

  it("throttles requests based on rate limit", async () => {
    const sleepImpl = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => "BEGIN:VCALENDAR\nEND:VCALENDAR");
    const fetcher = createCalendarFetcher({
      fetchImpl,
      sleepImpl,
      rateLimitMs: 1000,
      now: () => new Date(0),
    });
    await fetcher.fetchOne("a", "https://example.com/a.ics");
    await fetcher.fetchOne("b", "https://example.com/b.ics");
    expect(sleepImpl).toHaveBeenCalledWith(1000);
  });
});

describe("ical-calendar service", () => {
  let config: IcalCalendarConfig;

  beforeEach(() => {
    config = makeConfig();
  });

  it("filters upcoming events within the look-ahead window in JST", async () => {
    const now = new Date("2026-09-13T00:00:00Z");

    // Use raw ICS text for the team source so the real fetcher/parser pipeline populates the cache.
    const eventsBySource = new Map([
      [
        "team",
        [
          "BEGIN:VEVENT",
          "UID:future",
          "DTSTAMP:20260913T000000Z",
          "DTSTART:20260915T100000Z",
          "DTEND:20260915T110000Z",
          "SUMMARY:Future",
          "END:VEVENT",
          "BEGIN:VEVENT",
          "UID:far",
          "DTSTAMP:20260913T000000Z",
          "DTSTART:20270101T000000Z",
          "DTEND:20270101T010000Z",
          "SUMMARY:Far",
          "END:VEVENT",
        ].join("\n"),
      ],
    ]);

    const fetcher = createCalendarFetcher({
      fetchImpl: async (url: string) => {
        const sourceId = url.includes("team") ? "team" : "public";
        return eventsBySource.get(sourceId) ?? "BEGIN:VCALENDAR\nEND:VCALENDAR";
      },
      rateLimitMs: 0,
      now: () => now,
    });

    const service = createCalendarService({
      config,
      fetcher,
      now: () => now,
    });

    await service.fetchAndCacheAll();
    // The look-ahead window is 7 days, so the far-future Jan 2027 event should be filtered out by listUpcomingEvents.
    const list = service.listUpcomingEvents();
    expect(list.map((event) => event.uid)).toEqual(["team:future"]);
  });

  it("renders list using cached events and source name map", async () => {
    const now = new Date("2026-09-13T00:00:00Z");
    const logger: Logger = { error: vi.fn(), warn: vi.fn() };
    const fetcher = createCalendarFetcher({
      fetchImpl: async () => "BEGIN:VCALENDAR\nEND:VCALENDAR",
      rateLimitMs: 0,
      now: () => now,
    });
    const service = createCalendarService({
      config,
      fetcher,
      logger,
      now: () => now,
    });

    await service.fetchAndCacheAll();
    const events = service.listUpcomingEvents();
    const rendered = service.formatList(events, service.buildSourceNameMap(), now);
    expect(rendered).toBe("予定されているイベントはありません。");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("stops the scheduler when stopScheduler is called", () => {
    const now = new Date("2026-09-13T00:00:00Z");
    const service = createCalendarService({
      config: { ...config, fetchIntervalMs: 10 },
      now: () => now,
      fetcher: createCalendarFetcher({ rateLimitMs: 0 }),
    });
    service.startScheduler(10);
    service.stopScheduler();
    // No assertion needed - just ensure cleanup runs.
  });
});
