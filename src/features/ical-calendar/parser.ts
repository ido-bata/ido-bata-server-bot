import type { CalendarComponent, CalendarResponse, VEvent } from "node-ical";

import type { CalendarEvent } from "./types.js";

export function parseCalendarEvents(
  response: CalendarResponse,
  sourceId: string,
  now: Date = new Date(),
): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  for (const value of Object.values(response)) {
    if (!isVEvent(value)) {
      continue;
    }
    const event = convertEvent(value, sourceId, now);
    if (event) {
      events.push(event);
    }
  }
  return events;
}

function isVEvent(value: CalendarComponent | undefined): value is VEvent {
  return Boolean(value && value.type === "VEVENT");
}

function convertEvent(event: VEvent, sourceId: string, now: Date): CalendarEvent | null {
  const startRaw = event.start;
  if (!startRaw) {
    return null;
  }

  const startAt = toDate(startRaw, now);
  if (!startAt) {
    return null;
  }
  const endRaw = event.end;
  const endAt = endRaw ? toDate(endRaw, now) : null;

  return {
    uid: `${sourceId}:${event.uid}`,
    sourceId,
    summary: extractValue(event.summary) ?? "(no title)",
    description: extractValue(event.description) ?? "",
    location: extractValue(event.location) ?? "",
    startAt,
    endAt,
    isAllDay: event.datetype === "date" || Boolean(startRaw.dateOnly),
  };
}

function toDate(value: Date, fallback: Date): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (Number.isNaN(fallback.getTime())) {
    return null;
  }
  return new Date(fallback.getTime());
}

function extractValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null && "val" in value) {
    const val = (value as { val: unknown }).val;
    if (typeof val === "string") {
      return val;
    }
  }
  return undefined;
}
