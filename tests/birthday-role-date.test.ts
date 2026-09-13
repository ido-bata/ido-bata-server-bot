import { describe, expect, it } from "vitest";

import {
  getNextJstMidnightUtc,
  isLeapYear,
  nextJstMidnightUtc,
  parseBirthdayDate,
  toJstDate,
} from "../src/features/birthday-role/date.js";

describe("birthday-role date helpers", () => {
  describe("toJstDate", () => {
    it("converts a UTC instant to its JST calendar day", () => {
      // 2026-04-01T17:00:00Z is 2026-04-02T02:00 JST.
      const result = toJstDate(new Date("2026-04-01T17:00:00Z"));
      expect(result).toEqual({ year: 2026, month: 4, day: 2 });
    });

    it("keeps the same calendar day across the JST boundary from the west", () => {
      // 2026-04-01T14:59:00Z is 2026-04-01T23:59 JST — same day.
      const result = toJstDate(new Date("2026-04-01T14:59:00Z"));
      expect(result).toEqual({ year: 2026, month: 4, day: 1 });
    });

    it("flips the calendar day across the JST boundary from the east", () => {
      // 2026-04-01T15:00:00Z is 2026-04-02T00:00 JST — next day.
      const result = toJstDate(new Date("2026-04-01T15:00:00Z"));
      expect(result).toEqual({ year: 2026, month: 4, day: 2 });
    });
  });

  describe("nextJstMidnightUtc", () => {
    it("returns the UTC instant for a JST midnight", () => {
      // 2026-04-02T00:00 JST == 2026-04-01T15:00:00Z.
      const instant = nextJstMidnightUtc(new Date("2026-04-01T17:00:00Z"), 2026, 4, 2);
      expect(instant.toISOString()).toBe("2026-04-01T15:00:00.000Z");
    });
  });

  describe("getNextJstMidnightUtc", () => {
    it("returns today's JST midnight when called before it", () => {
      // 2026-04-01T10:00Z is 19:00 JST, midnight has not happened yet.
      const instant = getNextJstMidnightUtc(new Date("2026-04-01T10:00:00Z"));
      expect(instant.toISOString()).toBe("2026-04-01T15:00:00.000Z");
    });

    it("returns tomorrow's JST midnight when called after it", () => {
      // 2026-04-01T17:00Z is 02:00 JST on 2026-04-02.
      const instant = getNextJstMidnightUtc(new Date("2026-04-01T17:00:00Z"));
      expect(instant.toISOString()).toBe("2026-04-02T15:00:00.000Z");
    });

    it("handles month rollover", () => {
      // 2026-04-30T17:00Z is 2026-05-01T02:00 JST.
      const instant = getNextJstMidnightUtc(new Date("2026-04-30T17:00:00Z"));
      expect(instant.toISOString()).toBe("2026-05-01T15:00:00.000Z");
    });
  });

  describe("parseBirthdayDate", () => {
    it("accepts a canonical YYYY-MM-DD", () => {
      expect(parseBirthdayDate("1990-04-02")).toEqual({ year: 1990, month: 4, day: 2 });
    });

    it("trims surrounding whitespace", () => {
      expect(parseBirthdayDate("  1990-04-02  ")).toEqual({ year: 1990, month: 4, day: 2 });
    });

    it("rejects non-string input", () => {
      expect(parseBirthdayDate("")).toBeNull();
      expect(parseBirthdayDate("1990/04/02")).toBeNull();
      expect(parseBirthdayDate("1990-4-2")).toBeNull();
      expect(parseBirthdayDate("not-a-date")).toBeNull();
    });

    it("rejects impossible month and day ranges", () => {
      expect(parseBirthdayDate("1990-13-01")).toBeNull();
      expect(parseBirthdayDate("1990-00-01")).toBeNull();
      expect(parseBirthdayDate("1990-04-31")).toBeNull();
    });

    it("accepts Feb 29 on a leap year", () => {
      expect(parseBirthdayDate("2024-02-29")).toEqual({ year: 2024, month: 2, day: 29 });
    });

    it("rejects Feb 29 on a non-leap year", () => {
      expect(parseBirthdayDate("2026-02-29")).toBeNull();
    });
  });

  describe("isLeapYear", () => {
    it("marks century years divisible by 400 as leap", () => {
      expect(isLeapYear(2000)).toBe(true);
    });

    it("marks century years not divisible by 400 as non-leap", () => {
      expect(isLeapYear(1900)).toBe(false);
    });

    it("marks every-4-years as leap and others as non-leap", () => {
      expect(isLeapYear(2024)).toBe(true);
      expect(isLeapYear(2025)).toBe(false);
      expect(isLeapYear(2026)).toBe(false);
    });
  });
});
