import type { CalendarResponse } from "node-ical";
import ical from "node-ical";

import { parseCalendarEvents } from "./parser.js";
import type { CalendarEvent, CalendarFetchResult } from "./types.js";

export type CalendarFetcher = {
  fetchAll: (sources: ReadonlyArray<{ id: string; url: string }>) => Promise<CalendarFetchResult>;
  fetchOne: (id: string, url: string) => Promise<CalendarEvent[]>;
};

export type CalendarFetcherOptions = {
  rateLimitMs?: number;
  fetchImpl?: (url: string) => Promise<string>;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Per-request timeout in milliseconds. Default 30 s — long enough for a
   *  large iCal feed on a slow link, short enough that one unresponsive
   *  calendar host does not stall subsequent fetches in `fetchAll`. */
  fetchTimeoutMs?: number;
};

export function createCalendarFetcher(options: CalendarFetcherOptions = {}): CalendarFetcher {
  const rateLimitMs = options.rateLimitMs ?? 60_000;
  const fetchTimeoutMs = options.fetchTimeoutMs ?? 30_000;
  const fetchImpl = options.fetchImpl ?? ((url: string) => defaultFetch(url, fetchTimeoutMs));
  const sleepImpl =
    options.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());
  let lastFetchAt: number | null = null;

  async function throttle(): Promise<void> {
    if (lastFetchAt === null) {
      lastFetchAt = now().getTime();
      return;
    }
    const elapsed = now().getTime() - lastFetchAt;
    if (elapsed < rateLimitMs) {
      await sleepImpl(rateLimitMs - elapsed);
    }
    lastFetchAt = now().getTime();
  }

  async function fetchOne(id: string, url: string): Promise<CalendarEvent[]> {
    await throttle();
    const body = await fetchImpl(url);
    const response: CalendarResponse = ical.parseICS(body);
    return parseCalendarEvents(response, id, now());
  }

  async function fetchAll(
    sources: ReadonlyArray<{ id: string; url: string }>,
  ): Promise<CalendarFetchResult> {
    const events: CalendarEvent[] = [];
    const failedSources: { id: string; reason: string }[] = [];

    for (const source of sources) {
      try {
        const fetched = await fetchOne(source.id, source.url);
        for (const event of fetched) {
          events.push(event);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failedSources.push({ id: source.id, reason: message });
      }
    }

    return {
      events,
      failedSources,
      fetchedAt: now().toISOString(),
    };
  }

  return { fetchAll, fetchOne };
}

async function defaultFetch(url: string, fetchTimeoutMs = 30_000): Promise<string> {
  // `AbortSignal.timeout` was added in Node 18+. An unresponsive calendar
  // host would otherwise let the request stall past `setInterval` ticks
  // and pile up parallel fetches in `startScheduler`.
  const response = await fetch(url, { signal: AbortSignal.timeout(fetchTimeoutMs) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.text();
}
