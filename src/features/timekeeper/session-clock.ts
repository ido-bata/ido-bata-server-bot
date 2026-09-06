import type { TimekeeperTimelineEvent } from "./timeline.js";

const TIMELINE_MINUTE_MS = 60_000;
const DEFAULT_EVENT_DURATION_MS = 60_000;

export type SessionClock = {
  minuteMs: number;
  runBase: number;
  timelineBase: number;
};

export function findTimelineStartIndex(
  timeline: readonly TimekeeperTimelineEvent[],
  now: Date,
): number {
  return timeline.findIndex((event) => {
    const eventEnd = event.endAt?.getTime() ?? event.at.getTime() + DEFAULT_EVENT_DURATION_MS;
    return now.getTime() < eventEnd;
  });
}

export function createSessionClock(
  timeline: readonly TimekeeperTimelineEvent[],
  startAt: Date,
  startIndex: number,
  minuteMs: number,
  runtimeNowMs: number,
): SessionClock {
  if (minuteMs === TIMELINE_MINUTE_MS) {
    return { minuteMs, runBase: runtimeNowMs, timelineBase: runtimeNowMs };
  }
  const isResuming = startIndex > 0;
  return {
    minuteMs,
    runBase: isResuming ? runtimeNowMs : startAt.getTime(),
    timelineBase: isResuming
      ? (timeline[startIndex]?.at.getTime() ?? startAt.getTime())
      : startAt.getTime(),
  };
}

export function getTimelineNow(clock: SessionClock, runtimeNowMs: number): Date {
  const elapsedRuntimeMs = runtimeNowMs - clock.runBase;
  const elapsedTimelineMs = (elapsedRuntimeMs / clock.minuteMs) * TIMELINE_MINUTE_MS;
  return new Date(clock.timelineBase + elapsedTimelineMs);
}

export function getDelayFor(clock: SessionClock, targetAt: Date, runtimeNowMs: number): number {
  const minutesFromBase = (targetAt.getTime() - clock.timelineBase) / TIMELINE_MINUTE_MS;
  const targetRuntimeMs = clock.runBase + minutesFromBase * clock.minuteMs;
  return targetRuntimeMs - runtimeNowMs;
}

export function clampTimeToEvent(event: TimekeeperTimelineEvent, time: Date): Date {
  if (!event.endAt) return event.at;
  if (time < event.at) return event.at;
  if (time > event.endAt) return event.endAt;
  return time;
}
