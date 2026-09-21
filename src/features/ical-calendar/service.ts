import { childFor, getRootLogger } from "../../lib/logger/index.js";
import { isStale, loadCache, mergeSourceEvents, saveCache } from "./cache.js";
import { findSource, type IcalCalendarConfig, readConfig } from "./config.js";
import { type CalendarFetcher, createCalendarFetcher } from "./fetcher.js";
import { filterUpcoming, listEventsMessage, showEventMessage, sortByStart } from "./format.js";
import type { Logger } from "./logger.js";
import type { CalendarCache, CalendarEvent } from "./types.js";

export type CalendarService = {
  buildSourceNameMap: () => Map<string, string>;
  fetchAndCacheAll: () => Promise<{
    cache: CalendarCache;
    failedSources: { id: string; reason: string }[];
  }>;
  listUpcomingEvents: (sourceIds?: string[] | null) => CalendarEvent[];
  formatList: (events: CalendarEvent[], sourceNames: Map<string, string>, now?: Date) => string;
  formatShow: (event: CalendarEvent) => string;
  resolveEvent: (eventId: string) => CalendarEvent | null;
  refreshIfStale: () => Promise<void>;
  startScheduler: (intervalMs?: number) => void;
  stopScheduler: () => void;
};

export type CalendarServiceOptions = {
  config?: IcalCalendarConfig;
  fetcher?: CalendarFetcher;
  logger?: Logger;
  now?: () => Date;
};

export function createCalendarService(options: CalendarServiceOptions = {}): CalendarService {
  const config = options.config ?? readConfig();
  const fetcher = options.fetcher ?? createCalendarFetcher({ rateLimitMs: config.rateLimitMs });
  const logger: Logger = options.logger ?? defaultLogger;
  const now = options.now ?? (() => new Date());

  let cache: CalendarCache = loadCache(config.cachePath);
  let timer: ReturnType<typeof setInterval> | null = null;

  function sourceNameFor(id: string): string {
    const source = findSource(config.sources, id);
    return source?.name ?? id;
  }

  function buildNameMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const source of config.sources) {
      map.set(source.id, source.name);
    }
    return map;
  }

  async function fetchAndCacheAll() {
    const result = await fetcher.fetchAll(config.sources);
    const grouped = groupEventsBySource(result.events);
    // Sources that failed to fetch keep their previous cached events (and timestamp);
    // only successfully fetched sources are merged below. This preserves partial state
    // when one source is temporarily unreachable.
    const failedIds = new Set(result.failedSources.map((failed) => failed.id));
    let nextCache = cache;
    for (const source of config.sources) {
      if (failedIds.has(source.id)) {
        continue;
      }
      const events = grouped.get(source.id) ?? [];
      nextCache = mergeSourceEvents(nextCache, source.id, events, result.fetchedAt);
    }
    cache = nextCache;
    saveCache(config.cachePath, cache);
    if (result.failedSources.length > 0) {
      for (const failed of result.failedSources) {
        logger.warn(`[ical-calendar] failed to fetch ${failed.id}: ${failed.reason}`);
      }
    }
    return { cache, failedSources: result.failedSources };
  }

  function computeLookAhead(): Date {
    const base = now();
    return new Date(base.getTime() + config.lookAheadDays * 24 * 60 * 60_000);
  }

  function listUpcomingEvents(sourceIds?: string[] | null): CalendarEvent[] {
    const events: CalendarEvent[] = [];
    for (const entry of cache.sources) {
      for (const event of entry.events) {
        events.push(event);
      }
    }
    return sortByStart(
      filterUpcoming(events, {
        now: now(),
        sourceIds: sourceIds ?? undefined,
        until: computeLookAhead(),
      }),
    );
  }

  function formatList(
    events: CalendarEvent[],
    sourceNames: Map<string, string>,
    reference: Date = now(),
  ): string {
    return listEventsMessage(events, sourceNames, reference);
  }

  function formatShow(event: CalendarEvent): string {
    return showEventMessage(event, sourceNameFor(event.sourceId));
  }

  function resolveEvent(eventId: string): CalendarEvent | null {
    for (const entry of cache.sources) {
      for (const event of entry.events) {
        if (event.uid === eventId) {
          return event;
        }
      }
    }
    return null;
  }

  async function refreshIfStale(): Promise<void> {
    const reference = now();
    const hasStaleEntry = cache.sources.some((entry) =>
      isStale(entry, config.staleAfterMs, reference),
    );
    if (!hasStaleEntry) {
      return;
    }
    try {
      await fetchAndCacheAll();
    } catch (error) {
      logger.error("[ical-calendar] refresh failed", error);
    }
  }

  function startScheduler(intervalMs: number = config.fetchIntervalMs): void {
    if (timer) {
      return;
    }
    // Guard against overlapping `fetchAndCacheAll` runs: the previous pass
    // can take longer than `intervalMs` (per-source rate-limit + many
    // sources), in which case the next tick must skip — otherwise two
    // passes interleave `saveCache` writes and the last writer wins.
    let inFlight = false;
    timer = setInterval(() => {
      if (inFlight) {
        logger.warn("[ical-calendar] previous fetch still in flight, skipping this tick");
        return;
      }
      inFlight = true;
      void fetchAndCacheAll()
        .catch((error) => {
          logger.error("[ical-calendar] periodic fetch failed", error);
        })
        .finally(() => {
          inFlight = false;
        });
    }, intervalMs);
  }

  function stopScheduler(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    buildSourceNameMap: buildNameMap,
    fetchAndCacheAll,
    listUpcomingEvents,
    formatList,
    formatShow,
    resolveEvent,
    refreshIfStale,
    startScheduler,
    stopScheduler,
  };
}

function groupEventsBySource(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const list = map.get(event.sourceId) ?? [];
    list.push(event);
    map.set(event.sourceId, list);
  }
  return map;
}

const icalCalendarLogger = childFor(getRootLogger(), "ical-calendar");

const defaultLogger: Logger = {
  error: (...args) =>
    icalCalendarLogger.error(args.length === 1 ? args[0] : { args }, "calendar log"),
  warn: (...args) =>
    icalCalendarLogger.warn(args.length === 1 ? args[0] : { args }, "calendar log"),
};
