import { basename } from "node:path";

import { describe, expect, it } from "vitest";
import { timekeeperConfig } from "../src/features/timekeeper/config.js";
import {
  getCurrentOrNextDailyStartAt,
  getNextDailyStartAt,
  getTimekeeperPreparationStartAt,
} from "../src/features/timekeeper/schedule.js";
import {
  buildProgressMessage,
  buildTimekeeperTimeline,
} from "../src/features/timekeeper/timeline.js";

describe("timekeeper timeline", () => {
  it("builds the full timeline in audio file order", () => {
    const timeline = buildTimekeeperTimeline(new Date("2026-04-01T21:00:00+09:00"));

    expect(
      timeline.map((event) => ({
        order: event.order,
        kind: event.kind,
        at: event.at.toISOString(),
        label: event.label,
        audio: basename(event.audioPath),
      })),
    ).toEqual([
      {
        order: 1,
        kind: "work-start-soon",
        at: "2026-04-01T11:59:00.000Z",
        label: "作業フェーズ 1",
        audio: expect.stringMatching(/^001_/),
      },
      {
        order: 2,
        kind: "phase-start",
        at: "2026-04-01T12:00:00.000Z",
        label: "作業フェーズ 1",
        audio: expect.stringMatching(/^002_/),
      },
      {
        order: 3,
        kind: "phase-ending-soon",
        at: "2026-04-01T12:14:00.000Z",
        label: "作業フェーズ 1",
        audio: expect.stringMatching(/^003_/),
      },
      {
        order: 4,
        kind: "break-start",
        at: "2026-04-01T12:15:00.000Z",
        label: "5分休憩",
        audio: expect.stringMatching(/^004_/),
      },
      {
        order: 5,
        kind: "work-start-soon",
        at: "2026-04-01T12:19:00.000Z",
        label: "作業フェーズ 2",
        audio: expect.stringMatching(/^005_/),
      },
      {
        order: 6,
        kind: "phase-start",
        at: "2026-04-01T12:20:00.000Z",
        label: "作業フェーズ 2",
        audio: expect.stringMatching(/^006_/),
      },
      {
        order: 7,
        kind: "phase-ending-soon",
        at: "2026-04-01T12:49:00.000Z",
        label: "作業フェーズ 2",
        audio: expect.stringMatching(/^007_/),
      },
      {
        order: 8,
        kind: "break-start",
        at: "2026-04-01T12:50:00.000Z",
        label: "5分休憩",
        audio: expect.stringMatching(/^008_/),
      },
      {
        order: 9,
        kind: "work-start-soon",
        at: "2026-04-01T12:54:00.000Z",
        label: "作業フェーズ 3",
        audio: expect.stringMatching(/^009_/),
      },
      {
        order: 10,
        kind: "phase-start",
        at: "2026-04-01T12:55:00.000Z",
        label: "作業フェーズ 3",
        audio: expect.stringMatching(/^010_/),
      },
      {
        order: 11,
        kind: "phase-ending-soon",
        at: "2026-04-01T13:39:00.000Z",
        label: "作業フェーズ 3",
        audio: expect.stringMatching(/^011_/),
      },
      {
        order: 12,
        kind: "session-end",
        at: "2026-04-01T13:40:00.000Z",
        label: "作業フェーズ 3",
        audio: expect.stringMatching(/^012_/),
      },
    ]);
  });

  it("formats phase and break messages as plain text with realtime progress", () => {
    const timeline = buildTimekeeperTimeline(new Date("2026-04-01T21:00:00+09:00"));

    expect(buildProgressMessage(timeline[1]!, timeline[1]!.at, 0)).toBe(
      [
        "## 作業フェーズ 1 (15分)",
        "終了予定: 21:15まで",
        "進捗: [============] 00/15分",
        "確認済み: 0人",
        "残り: 15分",
      ].join("\n"),
    );
    expect(buildProgressMessage(timeline[1]!, new Date("2026-04-01T12:07:00.000Z"), 3)).toBe(
      [
        "## 作業フェーズ 1 (15分)",
        "終了予定: 21:15まで",
        "進捗: [+++++=======] 07/15分",
        "確認済み: 3人",
        "残り: 8分",
      ].join("\n"),
    );
    expect(buildProgressMessage(timeline[3]!, timeline[3]!.at, 0)).toBe(
      [
        "## 5分休憩 (5分)",
        "終了予定: 21:20まで",
        "進捗: [============] 00/05分",
        "確認済み: 0人",
        "残り: 5分",
      ].join("\n"),
    );
    expect(buildProgressMessage(timeline[1]!, new Date("2026-04-01T12:15:00.000Z"), 4)).toBe(
      [
        "## 作業フェーズ 1 (15分)",
        "終了予定: 21:15まで",
        "進捗: [++++++++++++] 15/15分",
        "確認済み: 4人",
        "残り: 終了",
      ].join("\n"),
    );
    expect(buildProgressMessage(timeline[0]!, timeline[0]!.at, 0)).toBeNull();
  });

  it("schedules today when the current time is before 21:00 JST", () => {
    const nextStartAt = getNextDailyStartAt(new Date("2026-04-01T20:30:00+09:00"), 21, 0);

    expect(nextStartAt.toISOString()).toBe("2026-04-01T12:00:00.000Z");
  });

  it("keeps today's start when current time is still inside today's session window", () => {
    const nextStartAt = getCurrentOrNextDailyStartAt(new Date("2026-04-01T21:30:00+09:00"), 21, 0);

    expect(nextStartAt.toISOString()).toBe("2026-04-01T12:00:00.000Z");
  });

  it("schedules tomorrow when current time is already after today's session end", () => {
    const nextStartAt = getCurrentOrNextDailyStartAt(new Date("2026-04-01T22:50:00+09:00"), 21, 0);

    expect(nextStartAt.toISOString()).toBe("2026-04-02T12:00:00.000Z");
  });

  it("schedules tomorrow when current time is exactly at today's session end", () => {
    const nextStartAt = getCurrentOrNextDailyStartAt(new Date("2026-04-01T22:40:00+09:00"), 21, 0);

    expect(nextStartAt.toISOString()).toBe("2026-04-02T12:00:00.000Z");
  });

  it.each([4, 6])("rejects phaseCount %d with exact error message", (phaseCount) => {
    const phases =
      phaseCount === 4
        ? timekeeperConfig.phases.slice(0, 4)
        : [...timekeeperConfig.phases, timekeeperConfig.phases[0]!];

    expect(() =>
      buildTimekeeperTimeline(new Date("2026-04-01T21:00:00+09:00"), {
        ...timekeeperConfig,
        phases,
      }),
    ).toThrow(`Timekeeper requires exactly 5 phases, received ${phaseCount}`);
  });

  it("preparation starts 3 minutes before a 21:00 JST session start", () => {
    const sessionStartAt = new Date("2026-04-01T21:00:00+09:00");
    const preparationStartAt = getTimekeeperPreparationStartAt(sessionStartAt);

    expect(preparationStartAt.toISOString()).toBe("2026-04-01T11:57:00.000Z");
  });
});
