import { describe, expect, it } from "vitest";

import { parseBirthdayDate } from "../src/features/birthday-role/date.js";
import { getNextTickAfter, selectTodaysBirthdays } from "../src/features/birthday-role/schedule.js";

describe("birthday-role schedule", () => {
  it("returns the next assign tick at the upcoming JST midnight", () => {
    const tick = getNextTickAfter(new Date("2026-04-01T10:00:00Z"));
    expect(tick.phase).toBe("assign");
    expect(tick.at.toISOString()).toBe("2026-04-01T15:00:00.000Z");
  });

  it("rolls forward to the next day once JST midnight has passed", () => {
    const tick = getNextTickAfter(new Date("2026-04-01T17:00:00Z"));
    expect(tick.at.toISOString()).toBe("2026-04-02T15:00:00.000Z");
  });

  it("selects members whose stored date matches today in JST", () => {
    const matches = selectTodaysBirthdays(
      [
        { userId: "user-1", date: "1990-04-02" },
        { userId: "user-2", date: "1985-12-31" },
        { userId: "user-3", date: "2000-02-29" },
      ],
      { year: 2026, month: 4, day: 2 },
      parseBirthdayDate,
    );

    expect(matches).toEqual(["user-1"]);
  });

  it("ignores entries whose date string cannot be parsed", () => {
    const matches = selectTodaysBirthdays(
      [
        { userId: "user-bad", date: "garbage" },
        { userId: "user-good", date: "1990-04-02" },
      ],
      { year: 2026, month: 4, day: 2 },
      parseBirthdayDate,
    );

    expect(matches).toEqual(["user-good"]);
  });

  it("treats Feb 29 birthdays as a match on Feb 28 in non-leap years", () => {
    // The issue scopes the feature to month/day matching; year is ignored.
    const matches = selectTodaysBirthdays(
      [{ userId: "user-leap", date: "2000-02-29" }],
      { year: 2026, month: 2, day: 28 },
      parseBirthdayDate,
    );

    expect(matches).toEqual([]);
  });
});
