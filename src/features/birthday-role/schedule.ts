// Daily JST 0:00 scheduling math for the birthday-role feature. Two events
// fire each day in the configured timezone:
//   - 00:00 JST: assign the @Birthday role to today's birthday members
//   - 24h later (i.e. the next 00:00 JST): remove the role from yesterday's
//     birthday members
//
// The role-removal step runs a full day after the assignment, which lets us
// process a single, idempotent pass at every JST midnight.

import { getNextJstMidnightUtc, type JstDate } from "./date.js";

export type SchedulePhase = "assign" | "remove";

export type DailyTick = {
  phase: SchedulePhase;
  // UTC instant for when the tick should fire.
  at: Date;
};

export function getNextTickAfter(now: Date): DailyTick {
  const at = getNextJstMidnightUtc(now);
  return { phase: "assign", at };
}

// Lists all members whose birthday matches today in JST. Leap-year handling
// is delegated to parseBirthdayDate in date.ts.
export function selectTodaysBirthdays(
  birthdays: Iterable<{ userId: string; date: string }>,
  today: JstDate,
  parse: (input: string) => JstDate | null,
): string[] {
  const matches: string[] = [];

  for (const entry of birthdays) {
    const parsed = parse(entry.date);

    if (!parsed) {
      continue;
    }

    if (parsed.month === today.month && parsed.day === today.day) {
      matches.push(entry.userId);
    }
  }

  return matches;
}
