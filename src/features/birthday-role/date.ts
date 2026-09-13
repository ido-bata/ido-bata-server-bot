// JST-aware date helpers for the birthday feature. JST is fixed to UTC+9
// because the issue scopes the feature to a single timezone.

const JST_OFFSET_MINUTES = 9 * 60;

export type JstDate = {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
};

export function toJstDate(date: Date): JstDate {
  const jst = new Date(date.getTime() + JST_OFFSET_MINUTES * 60_000);
  return {
    year: jst.getUTCFullYear(),
    month: jst.getUTCMonth() + 1,
    day: jst.getUTCDate(),
  };
}

// Returns the next instant (in UTC) where JST date is exactly
// (year, month, day) at 00:00 JST. Useful for the "remove" scheduler.
export function nextJstMidnightUtc(
  now: Date,
  year: number,
  month: number,
  day: number,
): Date {
  const targetUtcMs =
    Date.UTC(year, month - 1, day, 0, 0, 0, 0) - JST_OFFSET_MINUTES * 60_000;
  return new Date(targetUtcMs);
}

// Returns the UTC instant for the next JST midnight strictly after `now`.
// Honors leap years because Date.UTC handles month rollover natively.
export function getNextJstMidnightUtc(now: Date): Date {
  const { year, month, day } = toJstDate(now);
  const todayMidnight = nextJstMidnightUtc(now, year, month, day);

  if (todayMidnight.getTime() > now.getTime()) {
    return todayMidnight;
  }

  // Roll to the next day in JST, then re-derive the UTC instant.
  const tomorrowJst = new Date(
    Date.UTC(year, month - 1, day + 1, 0, 0, 0, 0) + JST_OFFSET_MINUTES * 60_000,
  );
  return nextJstMidnightUtc(
    now,
    tomorrowJst.getUTCFullYear(),
    tomorrowJst.getUTCMonth() + 1,
    tomorrowJst.getUTCDate(),
  );
}

export function parseBirthdayDate(input: string): JstDate | null {
  // Strict YYYY-MM-DD. We deliberately do not accept other formats so
  // users cannot smuggle in timezones or partial dates.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());

  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1] ?? "", 10);
  const month = Number.parseInt(match[2] ?? "", 10);
  const day = Number.parseInt(match[3] ?? "", 10);

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  // Reject impossible dates such as Feb 30 or Feb 29 in non-leap years.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

export function isLeapYear(year: number): boolean {
  if (year % 400 === 0) return true;
  if (year % 100 === 0) return false;
  return year % 4 === 0;
}
