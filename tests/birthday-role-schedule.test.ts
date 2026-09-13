import { describe, expect, it } from "vitest";

import {
  type JstDate,
  parseBirthdayDate,
  previousJstDate,
} from "../src/features/birthday-role/date.js";
import { getNextTickAfter, selectBirthdaysOnDate } from "../src/features/birthday-role/schedule.js";

describe("birthday-role schedule", () => {
  it("returns the next tick at the upcoming JST midnight", () => {
    const tick = getNextTickAfter(new Date("2026-04-01T10:00:00Z"));
    expect(tick.at.toISOString()).toBe("2026-04-01T15:00:00.000Z");
  });

  it("rolls forward to the next day once JST midnight has passed", () => {
    const tick = getNextTickAfter(new Date("2026-04-01T17:00:00Z"));
    expect(tick.at.toISOString()).toBe("2026-04-02T15:00:00.000Z");
  });

  it("selects members whose stored date matches the target in JST", () => {
    const matches = selectBirthdaysOnDate(
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
    const matches = selectBirthdaysOnDate(
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
    const matches = selectBirthdaysOnDate(
      [{ userId: "user-leap", date: "2000-02-29" }],
      { year: 2026, month: 2, day: 28 },
      parseBirthdayDate,
    );

    expect(matches).toEqual([]);
  });

  describe("previousJstDate", () => {
    const cases: Array<{ today: JstDate; expected: JstDate }> = [
      { today: { year: 2026, month: 4, day: 2 }, expected: { year: 2026, month: 4, day: 1 } },
      { today: { year: 2026, month: 5, day: 1 }, expected: { year: 2026, month: 4, day: 30 } },
      { today: { year: 2027, month: 1, day: 1 }, expected: { year: 2026, month: 12, day: 31 } },
      { today: { year: 2024, month: 3, day: 1 }, expected: { year: 2024, month: 2, day: 29 } },
    ];

    for (const { today, expected } of cases) {
      it(`returns ${expected.year}-${expected.month}-${expected.day} for ${today.year}-${today.month}-${today.day}`, () => {
        expect(previousJstDate(today)).toEqual(expected);
      });
    }
  });
});
