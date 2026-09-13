import type { ScheduledAnnouncementEntry } from "./config.js";
import { getJstOffsetMinutes } from "./config.js";

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

export type ScheduledFire = {
  entry: ScheduledAnnouncementEntry;
  fireAt: Date;
};

function shiftToJst(now: Date): Date {
  return new Date(now.getTime() + getJstOffsetMinutes() * MS_PER_MINUTE);
}

function jstWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  // Build a UTC instant whose UTC fields match the desired JST wall-clock
  // values, then subtract the JST offset to get the actual UTC instant.
  const asIfUtc = new Date(Date.UTC(year, month, day, hour, minute, 0, 0));
  return new Date(asIfUtc.getTime() - getJstOffsetMinutes() * MS_PER_MINUTE);
}

export function getNextFireTime(entry: ScheduledAnnouncementEntry, now: Date): Date | null {
  if (!entry.enabled) {
    return null;
  }

  if (entry.oneShotDate) {
    return getNextOneShotFireTime(entry, now);
  }

  if (entry.weekday !== undefined) {
    return getNextWeeklyFireTime(entry, now);
  }

  return null;
}

function getNextOneShotFireTime(entry: ScheduledAnnouncementEntry, now: Date): Date | null {
  if (!entry.oneShotDate) {
    return null;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(entry.oneShotDate);
  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1]!, 10);
  const month = Number.parseInt(match[2]!, 10);
  const day = Number.parseInt(match[3]!, 10);

  const candidate = jstWallClockToUtc(year, month - 1, day, entry.hour, entry.minute);

  if (candidate.getTime() <= now.getTime()) {
    return null;
  }

  return candidate;
}

function getNextWeeklyFireTime(entry: ScheduledAnnouncementEntry, now: Date): Date | null {
  if (entry.weekday === undefined) {
    return null;
  }

  const nowJst = shiftToJst(now);
  const todayWeekday = nowJst.getUTCDay();
  let daysAhead = (entry.weekday - todayWeekday + 7) % 7;

  const todayCandidate = jstWallClockToUtc(
    nowJst.getUTCFullYear(),
    nowJst.getUTCMonth(),
    nowJst.getUTCDate(),
    entry.hour,
    entry.minute,
  );

  if (daysAhead === 0 && todayCandidate.getTime() <= now.getTime()) {
    daysAhead = 7;
  }

  const targetJstDate = nowJst.getUTCDate() + daysAhead;
  // Date.UTC normalizes overflow (e.g., month rollover) the same way Intl does,
  // so adding `daysAhead` to the JST day is safe across month boundaries.
  const candidateJst = new Date(
    Date.UTC(
      nowJst.getUTCFullYear(),
      nowJst.getUTCMonth(),
      targetJstDate,
      entry.hour,
      entry.minute,
      0,
      0,
    ),
  );

  return new Date(candidateJst.getTime() - getJstOffsetMinutes() * MS_PER_MINUTE);
}

export function pickNextFires(
  entries: readonly ScheduledAnnouncementEntry[],
  now: Date,
  limit?: number,
): ScheduledFire[] {
  const fires: ScheduledFire[] = [];
  for (const entry of entries) {
    const fireAt = getNextFireTime(entry, now);
    if (fireAt) {
      fires.push({ entry, fireAt });
    }
  }

  fires.sort((left, right) => left.fireAt.getTime() - right.fireAt.getTime());

  return typeof limit === "number" ? fires.slice(0, limit) : fires;
}

export function getNextWeeklyFireAfter(previousFireAt: Date): Date {
  // Anchor the next weekly fire on the previous fire and add exactly 7 days so
  // the cadence is drift-free across DST transitions.
  return new Date(previousFireAt.getTime() + 7 * MS_PER_DAY);
}
