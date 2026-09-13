// Daily JST 0:00 scheduling math for the birthday-role feature. Each JST
// midnight runs a single combined tick that:
//   1. Removes yesterday's @Birthday role assignments (yesterday's M/D
//      matchers only), and
//   2. Grants today's @Birthday role assignments (today's M/D matchers).
//
// Both steps happen back-to-back so a member whose birthday was yesterday
// and who shares the same M/D as today gets the role re-applied without a
// gap.

import { getNextJstMidnightUtc, type JstDate } from "./date.js";

export type DailyTick = {
  // UTC instant for when the tick should fire.
  at: Date;
};

export function getNextTickAfter(now: Date): DailyTick {
  const at = getNextJstMidnightUtc(now);
  return { at };
}

// Lists all members whose birthday matches `target` in JST. Leap-year
// handling is delegated to parseBirthdayDate in date.ts.
export function selectBirthdaysOnDate(
  birthdays: Iterable<{ userId: string; date: string }>,
  target: JstDate,
  parse: (input: string) => JstDate | null,
): string[] {
  const matches: string[] = [];

  for (const entry of birthdays) {
    const parsed = parse(entry.date);

    if (!parsed) {
      continue;
    }

    if (parsed.month === target.month && parsed.day === target.day) {
      matches.push(entry.userId);
    }
  }

  return matches;
}
