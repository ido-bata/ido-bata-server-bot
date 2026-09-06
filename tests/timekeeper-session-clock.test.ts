import { describe, expect, it } from "vitest";
import {
  clampTimeToEvent,
  createSessionClock,
  findTimelineStartIndex,
  getDelayFor,
  getTimelineNow,
} from "../src/features/timekeeper/session-clock.js";
import {
  buildProgressMessage,
  buildTimekeeperTimeline,
} from "../src/features/timekeeper/timeline.js";

const TIMELINE_START_AT = new Date("2026-04-01T21:00:00+09:00");

describe("timekeeper session clock", () => {
  const timeline = buildTimekeeperTimeline(TIMELINE_START_AT);

  describe("findTimelineStartIndex", () => {
    it("returns 0 when now is one second before the first event", () => {
      const now = new Date("2026-04-01T20:58:59+09:00");
      expect(findTimelineStartIndex(timeline, now)).toBe(0);
    });

    it("returns 3 when now is between break-start and work2 phase-end", () => {
      const now = new Date("2026-04-01T21:16:00+09:00");
      expect(findTimelineStartIndex(timeline, now)).toBe(3);
    });

    it("returns -1 when now is after the last event's 60s fallback", () => {
      const now = new Date("2026-04-01T22:41:00+09:00");
      expect(findTimelineStartIndex(timeline, now)).toBe(-1);
    });
  });

  describe("createSessionClock", () => {
    const runtimeNowMs = 1_000_000;

    it("anchors runBase and timelineBase to runtimeNowMs for normal (60_000) clocks", () => {
      const clock = createSessionClock(timeline, TIMELINE_START_AT, 0, 60_000, runtimeNowMs);
      expect(clock.runBase).toBe(runtimeNowMs);
      expect(clock.timelineBase).toBe(runtimeNowMs);
      expect(clock.minuteMs).toBe(60_000);
    });

    it("keeps wall clock anchoring even when resuming (startIndex > 0) under normal clocks", () => {
      const clock = createSessionClock(timeline, TIMELINE_START_AT, 3, 60_000, runtimeNowMs);
      expect(clock.runBase).toBe(runtimeNowMs);
      expect(clock.timelineBase).toBe(runtimeNowMs);
    });

    it("uses startAt for both bases when minuteMs is compressed and startIndex is 0", () => {
      const clock = createSessionClock(timeline, TIMELINE_START_AT, 0, 1_000, runtimeNowMs);
      expect(clock.runBase).toBe(TIMELINE_START_AT.getTime());
      expect(clock.timelineBase).toBe(TIMELINE_START_AT.getTime());
    });

    it("anchors runBase to runtimeNowMs and timelineBase to the resumed event when compressed mid-session", () => {
      const clock = createSessionClock(timeline, TIMELINE_START_AT, 3, 1_000, runtimeNowMs);
      expect(clock.runBase).toBe(runtimeNowMs);
      expect(clock.timelineBase).toBe(timeline[3]!.at.getTime());
    });
  });

  describe("getDelayFor", () => {
    const runtimeNowMs = 2_000_000;

    it("returns the wall-clock delta when the clock is normal (60_000)", () => {
      const clock = createSessionClock(timeline, TIMELINE_START_AT, 0, 60_000, runtimeNowMs);
      const targetAt = timeline[1]!.at;
      expect(getDelayFor(clock, targetAt, runtimeNowMs)).toBe(targetAt.getTime() - runtimeNowMs);
    });

    it("returns 15_000 for a 15-minute target under a fresh compressed clock", () => {
      const startAtMs = TIMELINE_START_AT.getTime();
      const clock = createSessionClock(timeline, TIMELINE_START_AT, 0, 1_000, startAtMs);
      const targetAt = new Date(TIMELINE_START_AT.getTime() + 15 * 60_000);
      expect(getDelayFor(clock, targetAt, startAtMs)).toBe(15_000);
    });

    it("returns 5_000 for a 5-minute target under a mid-session compressed clock", () => {
      const runtimeNowMs = 5_000_000;
      const clock = createSessionClock(timeline, TIMELINE_START_AT, 3, 1_000, runtimeNowMs);
      const targetAt = new Date(timeline[3]!.at.getTime() + 5 * 60_000);
      expect(getDelayFor(clock, targetAt, runtimeNowMs)).toBe(5_000);
    });
  });

  describe("getTimelineNow", () => {
    it("returns Date(nowMs) for normal (60_000) clocks", () => {
      const runtimeNowMs = 4_242_424_242;
      const clock = createSessionClock(timeline, TIMELINE_START_AT, 0, 60_000, runtimeNowMs);
      expect(getTimelineNow(clock, runtimeNowMs).getTime()).toBe(runtimeNowMs);
    });

    it("scales compressed runtime elapsed into wall-clock minutes", () => {
      const startAtMs = TIMELINE_START_AT.getTime();
      const clock = createSessionClock(timeline, TIMELINE_START_AT, 0, 1_000, startAtMs);
      const runtimeNow = startAtMs + 7_000;
      expect(getTimelineNow(clock, runtimeNow).getTime()).toBe(startAtMs + 7 * 60_000);
    });
  });

  describe("clampTimeToEvent", () => {
    it("returns the event.at when time is before the event", () => {
      const event = timeline[1]!;
      const earlier = new Date(event.at.getTime() - 60_000);
      expect(clampTimeToEvent(event, earlier)).toEqual(event.at);
    });

    it("returns the event.endAt when time is past the event", () => {
      const event = timeline[1]!;
      expect(event.endAt).not.toBeNull();
      const later = new Date(event.endAt!.getTime() + 60_000);
      expect(clampTimeToEvent(event, later)).toEqual(event.endAt!);
    });

    it("returns the input time when it falls inside the event window", () => {
      const event = timeline[1]!;
      const inside = new Date(event.at.getTime() + 5 * 60_000);
      expect(clampTimeToEvent(event, inside)).toEqual(inside);
    });

    it("returns event.at when event.endAt is null", () => {
      const event = timeline[0]!;
      expect(event.endAt).toBeNull();
      expect(clampTimeToEvent(event, new Date(0))).toEqual(event.at);
    });
  });

  describe("buildProgressMessage integration", () => {
    it("formats 07/15 progress after 7 elapsed compressed minutes", () => {
      const startAtMs = TIMELINE_START_AT.getTime();
      const clock = createSessionClock(timeline, TIMELINE_START_AT, 0, 1_000, startAtMs);
      const event = timeline[1]!;
      const timelineNow = getTimelineNow(clock, startAtMs + 7_000);
      const message = buildProgressMessage(event, clampTimeToEvent(event, timelineNow), 0);
      expect(message).toContain("07/15分");
    });
  });
});
