import { describe, expect, it } from "vitest";
import {
  formatJstDate,
  formatJstDateTime,
  formatJstTime,
  listEventsMessage,
  showEventMessage,
  sortByStart,
} from "../src/features/ical-calendar/format.js";
import { parseCalendarEvents } from "../src/features/ical-calendar/parser.js";
import type { CalendarEvent } from "../src/features/ical-calendar/types.js";

describe("ical-calendar parser", () => {
  it("extracts events with summary and start/end", () => {
    const response = {
      "event-1": {
        type: "VEVENT",
        uid: "evt-1",
        dtstamp: new Date("2025-01-01T00:00:00Z"),
        start: new Date("2025-01-15T13:00:00Z"),
        end: new Date("2025-01-15T14:00:00Z"),
        summary: "Sprint review",
        datetype: "date-time",
      },
    } as never;

    const events = parseCalendarEvents(response, "team");
    expect(events).toHaveLength(1);
    expect(events[0]?.uid).toBe("team:evt-1");
    expect(events[0]?.summary).toBe("Sprint review");
    expect(events[0]?.startAt.toISOString()).toBe("2025-01-15T13:00:00.000Z");
    expect(events[0]?.endAt?.toISOString()).toBe("2025-01-15T14:00:00.000Z");
  });

  it("skips non-VEVENT components", () => {
    const response = {
      todo1: { type: "VTODO", uid: "todo-1" },
      event1: {
        type: "VEVENT",
        uid: "evt",
        dtstamp: new Date("2025-01-01T00:00:00Z"),
        start: new Date("2025-02-01T10:00:00Z"),
        summary: "Standup",
        datetype: "date-time",
      },
    } as never;
    const events = parseCalendarEvents(response, "src");
    expect(events).toHaveLength(1);
    expect(events[0]?.summary).toBe("Standup");
  });

  it("falls back to (no title) when summary is missing", () => {
    const response = {
      event1: {
        type: "VEVENT",
        uid: "evt",
        dtstamp: new Date("2025-01-01T00:00:00Z"),
        start: new Date("2025-02-01T10:00:00Z"),
        datetype: "date-time",
      },
    } as never;
    const events = parseCalendarEvents(response, "src");
    expect(events[0]?.summary).toBe("(no title)");
  });

  it("detects full-day events via datetype", () => {
    const response = {
      event1: {
        type: "VEVENT",
        uid: "evt",
        dtstamp: new Date("2025-01-01T00:00:00Z"),
        start: new Date("2025-02-01T00:00:00Z"),
        summary: "Holiday",
        datetype: "date",
      },
    } as never;
    const events = parseCalendarEvents(response, "src");
    expect(events[0]?.isAllDay).toBe(true);
  });
});

describe("ical-calendar formatter", () => {
  const sampleEvents: CalendarEvent[] = [
    {
      uid: "src:1",
      sourceId: "src",
      summary: "Standup",
      description: "",
      location: "Tokyo",
      startAt: new Date("2025-01-15T22:00:00Z"), // 07:00 JST next day
      endAt: new Date("2025-01-15T22:30:00Z"),
      isAllDay: false,
    },
    {
      uid: "src:2",
      sourceId: "src",
      summary: "Holiday",
      description: "Public holiday",
      location: "",
      startAt: new Date("2025-01-20T00:00:00Z"),
      endAt: null,
      isAllDay: true,
    },
  ];

  it("formats date in JST", () => {
    expect(formatJstDate(new Date("2025-01-15T22:00:00Z"))).toBe("2025-01-16");
    expect(formatJstTime(new Date("2025-01-15T22:00:00Z"))).toBe("07:00");
  });

  it("combines date and time", () => {
    expect(formatJstDateTime(new Date("2025-01-15T22:00:00Z"))).toBe("2025-01-16 07:00");
  });

  it("renders a multi-event list with source names", () => {
    const sourceNames = new Map([["src", "チーム"]]);
    const rendered = listEventsMessage(sampleEvents, sourceNames, new Date("2025-01-15T00:00:00Z"));
    expect(rendered).toContain("直近の予定");
    expect(rendered).toContain("チーム");
    expect(rendered).toContain("Standup");
    expect(rendered).toContain("Holiday");
  });

  it("returns the empty state when no events", () => {
    const rendered = listEventsMessage([], new Map(), new Date());
    expect(rendered).toBe("予定されているイベントはありません。");
  });

  it("renders detail view with location and description", () => {
    const rendered = showEventMessage(sampleEvents[0]!, "チーム");
    expect(rendered).toContain("Standup");
    expect(rendered).toContain("チーム");
    expect(rendered).toContain("Tokyo");
    expect(rendered).not.toContain("詳細");
  });

  it("renders detail view for all-day event", () => {
    const rendered = showEventMessage(sampleEvents[1]!, "チーム");
    expect(rendered).toContain("Holiday");
    expect(rendered).toContain("終日");
  });

  it("sorts events by start date", () => {
    const a = { ...sampleEvents[0]! };
    const b = { ...sampleEvents[1]! };
    const sorted = sortByStart([b, a]);
    expect(sorted[0]?.uid).toBe("src:1");
  });
});
