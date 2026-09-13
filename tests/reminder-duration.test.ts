import { describe, expect, it } from "vitest";

import { formatDuration, formatDurationVerbose, parseDuration } from "../src/features/reminder/duration.js";

describe("reminder duration parser", () => {
  it("parses a single unit", () => {
    expect(parseDuration("30m")).toEqual({ ok: true, durationMs: 30 * 60_000, normalized: "30m" });
    expect(parseDuration("1h")).toEqual({ ok: true, durationMs: 60 * 60_000, normalized: "1h" });
    expect(parseDuration("2d")).toEqual({ ok: true, durationMs: 2 * 24 * 60 * 60_000, normalized: "2d" });
  });

  it("parses chained units", () => {
    const result = parseDuration("1h30m");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.durationMs).toBe(90 * 60_000);
      expect(result.normalized).toBe("1h30m");
    }
  });

  it("rejects empty input", () => {
    const result = parseDuration("");
    expect(result.ok).toBe(false);
  });

  it("rejects unknown characters", () => {
    const result = parseDuration("30 mins");
    expect(result.ok).toBe(false);
  });

  it("rejects sub-second durations", () => {
    const result = parseDuration("0s");
    expect(result.ok).toBe(false);
  });

  it("formats durations as canonical strings", () => {
    expect(formatDuration(90 * 60_000)).toBe("1h30m");
    expect(formatDuration(60_000)).toBe("1m");
  });

  it("formats durations in Japanese verbose form", () => {
    expect(formatDurationVerbose(90 * 60_000)).toBe("1時間30分");
    expect(formatDurationVerbose(2 * 24 * 60 * 60_000)).toBe("2日");
  });
});
