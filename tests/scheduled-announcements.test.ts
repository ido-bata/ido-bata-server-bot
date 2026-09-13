import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadScheduledAnnouncements,
  saveScheduledAnnouncements,
  scheduledAnnouncementsFileSchema,
} from "../src/features/scheduled-announcements/config.js";
import {
  getNextFireTime,
  getNextWeeklyFireAfter,
  pickNextFires,
} from "../src/features/scheduled-announcements/schedule.js";
import type { ChannelResolver } from "../src/features/scheduled-announcements/service.js";
import { createScheduledAnnouncementsService } from "../src/features/scheduled-announcements/service.js";

describe("scheduled-announcements config schema", () => {
  it("parses a valid weekly entry", () => {
    const result = scheduledAnnouncementsFileSchema.parse({
      entries: [
        {
          id: "weekly",
          channelId: "123",
          message: "hello",
          weekday: 1,
          hour: 9,
          minute: 30,
          enabled: true,
        },
      ],
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.id).toBe("weekly");
  });

  it("rejects entries that are missing both weekday and oneShotDate", () => {
    expect(() =>
      scheduledAnnouncementsFileSchema.parse({
        entries: [
          {
            id: "ambiguous",
            channelId: "123",
            message: "hello",
            hour: 9,
            minute: 30,
            enabled: true,
          },
        ],
      }),
    ).toThrow(/exactly one of weekday or oneShotDate/);
  });

  it("rejects entries that set both weekday and oneShotDate", () => {
    expect(() =>
      scheduledAnnouncementsFileSchema.parse({
        entries: [
          {
            id: "both",
            channelId: "123",
            message: "hello",
            weekday: 1,
            hour: 9,
            minute: 30,
            oneShotDate: "2026-12-31",
            enabled: true,
          },
        ],
      }),
    ).toThrow(/exactly one of weekday or oneShotDate/);
  });

  it("rejects oneShotDate that is not YYYY-MM-DD", () => {
    expect(() =>
      scheduledAnnouncementsFileSchema.parse({
        entries: [
          {
            id: "bad-date",
            channelId: "123",
            message: "hello",
            oneShotDate: "2026/12/31",
            hour: 9,
            minute: 30,
            enabled: true,
          },
        ],
      }),
    ).toThrow(/oneShotDate must be YYYY-MM-DD/);
  });
});

describe("scheduled-announcements file IO", () => {
  let workDir: string;
  let filePath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "scheduled-announcements-"));
    filePath = join(workDir, "scheduled-announcements.json");
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("returns an empty list when the file does not exist", () => {
    const result = loadScheduledAnnouncements({ filePath });

    expect(result.entries).toEqual([]);
    expect(result.filePath).toBe(filePath);
  });

  it("loads entries from an existing file", () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        entries: [
          {
            id: "weekly-1",
            channelId: "channel-1",
            message: "週次連絡",
            weekday: 1,
            hour: 9,
            minute: 0,
            enabled: true,
          },
        ],
      }),
      "utf8",
    );

    const result = loadScheduledAnnouncements({ filePath });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.id).toBe("weekly-1");
  });

  it("persists the entries back to disk", () => {
    saveScheduledAnnouncements(
      [
        {
          id: "oneshot-1",
          channelId: "channel-1",
          message: "単発告知",
          oneShotDate: "2026-12-31",
          hour: 9,
          minute: 0,
          enabled: true,
        },
      ],
      { filePath },
    );

    const result = loadScheduledAnnouncements({ filePath });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.id).toBe("oneshot-1");
    expect(result.entries[0]?.oneShotDate).toBe("2026-12-31");
  });
});

describe("getNextFireTime (JST-aware)", () => {
  it("schedules a weekly entry for later today when the time has not passed", () => {
    // 2026-04-01 is a Wednesday (JST). weekday 3 = Wednesday.
    const fireAt = getNextFireTime(
      {
        id: "wed-21",
        channelId: "c",
        message: "m",
        weekday: 3,
        hour: 21,
        minute: 0,
        enabled: true,
      },
      new Date("2026-04-01T05:00:00Z"), // 14:00 JST
    );

    expect(fireAt?.toISOString()).toBe("2026-04-01T12:00:00.000Z");
  });

  it("rolls to next week when today's JST time has already passed", () => {
    // 2026-04-01 Wednesday. weekday 3 (Wed), hour 9 already passed.
    const fireAt = getNextFireTime(
      { id: "wed-09", channelId: "c", message: "m", weekday: 3, hour: 9, minute: 0, enabled: true },
      new Date("2026-04-01T05:00:00Z"), // 14:00 JST, past 9:00
    );

    expect(fireAt?.toISOString()).toBe("2026-04-08T00:00:00.000Z");
  });

  it("schedules the next matching weekday when today is a different weekday", () => {
    // 2026-04-01 Wednesday. Want Friday (weekday 5).
    const fireAt = getNextFireTime(
      { id: "fri-09", channelId: "c", message: "m", weekday: 5, hour: 9, minute: 0, enabled: true },
      new Date("2026-04-01T00:00:00Z"), // 09:00 JST
    );

    expect(fireAt?.toISOString()).toBe("2026-04-03T00:00:00.000Z");
  });

  it("rolls the weekday forward across a month boundary", () => {
    // 2026-04-29 Wednesday. Want Tuesday next week (2026-05-05).
    const fireAt = getNextFireTime(
      {
        id: "tue-21",
        channelId: "c",
        message: "m",
        weekday: 2,
        hour: 21,
        minute: 0,
        enabled: true,
      },
      new Date("2026-04-29T12:00:00Z"), // 21:00 JST
    );

    expect(fireAt?.toISOString()).toBe("2026-05-05T12:00:00.000Z");
  });

  it("returns null for a disabled weekly entry", () => {
    const fireAt = getNextFireTime(
      { id: "x", channelId: "c", message: "m", weekday: 3, hour: 21, minute: 0, enabled: false },
      new Date("2026-04-01T00:00:00Z"),
    );

    expect(fireAt).toBeNull();
  });
});

describe("getNextFireTime (oneShotDate)", () => {
  it("schedules a future oneShotDate in JST", () => {
    // 2026-04-01 09:00 JST; oneShot 2026-04-10 12:00 JST.
    const fireAt = getNextFireTime(
      {
        id: "announce",
        channelId: "c",
        message: "m",
        oneShotDate: "2026-04-10",
        hour: 12,
        minute: 0,
        enabled: true,
      },
      new Date("2026-04-01T00:00:00Z"),
    );

    expect(fireAt?.toISOString()).toBe("2026-04-10T03:00:00.000Z");
  });

  it("returns null when the oneShotDate is in the past", () => {
    const fireAt = getNextFireTime(
      {
        id: "announce",
        channelId: "c",
        message: "m",
        oneShotDate: "2026-01-01",
        hour: 9,
        minute: 0,
        enabled: true,
      },
      new Date("2026-04-01T00:00:00Z"),
    );

    expect(fireAt).toBeNull();
  });

  it("returns null when the oneShotDate JST time has already passed today", () => {
    // 2026-04-10 14:00 JST; oneShot 2026-04-10 12:00 JST.
    const fireAt = getNextFireTime(
      {
        id: "announce",
        channelId: "c",
        message: "m",
        oneShotDate: "2026-04-10",
        hour: 12,
        minute: 0,
        enabled: true,
      },
      new Date("2026-04-10T05:00:00Z"),
    );

    expect(fireAt).toBeNull();
  });

  it("treats oneShotDate at JST midnight as 15:00 UTC the previous day", () => {
    const fireAt = getNextFireTime(
      {
        id: "announce",
        channelId: "c",
        message: "m",
        oneShotDate: "2026-04-10",
        hour: 0,
        minute: 0,
        enabled: true,
      },
      new Date("2026-04-01T00:00:00Z"),
    );

    expect(fireAt?.toISOString()).toBe("2026-04-09T15:00:00.000Z");
  });
});

describe("pickNextFires", () => {
  it("orders multiple entries by their next fire time", () => {
    const entries = [
      {
        id: "weekly-mon",
        channelId: "c",
        message: "m",
        weekday: 1,
        hour: 9,
        minute: 0,
        enabled: true,
      },
      {
        id: "oneshot-soon",
        channelId: "c",
        message: "m",
        oneShotDate: "2026-04-02",
        hour: 9,
        minute: 0,
        enabled: true,
      },
    ];

    const fires = pickNextFires(entries, new Date("2026-04-01T00:00:00Z"));

    expect(fires.map((f) => f.entry.id)).toEqual(["oneshot-soon", "weekly-mon"]);
  });

  it("skips disabled entries", () => {
    const entries = [
      {
        id: "disabled",
        channelId: "c",
        message: "m",
        weekday: 1,
        hour: 9,
        minute: 0,
        enabled: false,
      },
    ];

    expect(pickNextFires(entries, new Date("2026-04-01T00:00:00Z"))).toEqual([]);
  });
});

describe("getNextWeeklyFireAfter", () => {
  it("schedules the next fire exactly 7 days after the previous fire", () => {
    const previous = new Date("2026-04-01T12:00:00Z");
    const next = getNextWeeklyFireAfter(previous);

    expect(next.toISOString()).toBe("2026-04-08T12:00:00.000Z");
  });
});

describe("scheduled-announcements service", () => {
  function makeSendable(send: ReturnType<typeof vi.fn>) {
    return { send };
  }

  let workDir: string;
  let filePath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "scheduled-announcements-svc-"));
    filePath = join(workDir, "scheduled-announcements.json");
    vi.useFakeTimers();
    // Anchor fake clock to just before the JST fire time used in the fixtures
    // below so the setTimeout delay is a few seconds rather than ~56 years.
    vi.setSystemTime(new Date("2026-04-01T23:59:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("publishes the message and disables the one-shot entry after a successful send", async () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        entries: [
          {
            id: "oneshot-1",
            channelId: "channel-1",
            message: "単発告知",
            oneShotDate: "2026-04-02",
            hour: 9,
            minute: 0,
            enabled: true,
          },
        ],
      }),
      "utf8",
    );

    const send = vi.fn(async () => undefined);
    const client = { channels: { fetch: vi.fn() } } as unknown as Parameters<
      typeof createScheduledAnnouncementsService
    >[0];
    const resolver = vi.fn(async () => makeSendable(send)) as unknown as ChannelResolver;

    const service = createScheduledAnnouncementsService(client, {
      loadOptions: { filePath },
      resolveChannel: resolver,
    });

    service.start();

    // The next fire is 2026-04-02T00:00:00Z. Tick the clock past it.
    await vi.advanceTimersByTimeAsync(120_000);
    // Drain retry/idle timers and the post-fire scheduleNext() tick.
    await vi.advanceTimersByTimeAsync(120_000);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("単発告知");

    const entries = service.getEntries();
    expect(entries[0]?.enabled).toBe(false);

    service.stop();
  });

  it("retries once on send failure, then disables the one-shot entry", async () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        entries: [
          {
            id: "oneshot-fail",
            channelId: "channel-missing",
            message: "単発告知",
            oneShotDate: "2026-04-02",
            hour: 9,
            minute: 0,
            enabled: true,
          },
        ],
      }),
      "utf8",
    );

    const client = { channels: { fetch: vi.fn() } } as unknown as Parameters<
      typeof createScheduledAnnouncementsService
    >[0];
    const resolver = vi.fn(async () => null) as unknown as ChannelResolver;

    const service = createScheduledAnnouncementsService(client, {
      loadOptions: { filePath },
      resolveChannel: resolver,
      sleep: async () => undefined,
    });

    service.start();

    await vi.advanceTimersByTimeAsync(120_000);
    await vi.advanceTimersByTimeAsync(120_000);

    // After the second failure, the entry must be disabled to prevent a busy
    // loop trying to re-fire a one-shot that already happened.
    const entries = service.getEntries();
    expect(entries[0]?.enabled).toBe(false);

    service.stop();
  });

  it("is idempotent — does not re-send a one-shot that has already been disabled", async () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        entries: [
          {
            id: "oneshot-1",
            channelId: "channel-1",
            message: "単発告知",
            oneShotDate: "2026-04-02",
            hour: 9,
            minute: 0,
            enabled: false,
          },
        ],
      }),
      "utf8",
    );

    const send = vi.fn(async () => undefined);
    const client = { channels: { fetch: vi.fn() } } as unknown as Parameters<
      typeof createScheduledAnnouncementsService
    >[0];
    const resolver = vi.fn(async () => makeSendable(send)) as unknown as ChannelResolver;

    const service = createScheduledAnnouncementsService(client, {
      loadOptions: { filePath },
      resolveChannel: resolver,
    });

    service.start();

    await vi.advanceTimersByTimeAsync(86_400_000 * 7);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(send).not.toHaveBeenCalled();

    service.stop();
  });

  it("keeps a weekly entry on the schedule even when its send fails", async () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        entries: [
          {
            id: "weekly-1",
            channelId: "channel-missing",
            message: "週次連絡",
            weekday: 3,
            hour: 21,
            minute: 0,
            enabled: true,
          },
        ],
      }),
      "utf8",
    );

    const client = { channels: { fetch: vi.fn() } } as unknown as Parameters<
      typeof createScheduledAnnouncementsService
    >[0];
    const resolver = vi.fn(async () => null) as unknown as ChannelResolver;

    const service = createScheduledAnnouncementsService(client, {
      loadOptions: { filePath },
      resolveChannel: resolver,
      sleep: async () => undefined,
    });

    service.start();

    // The next fire is 2026-04-01T12:00:00Z (Wed 21:00 JST). We are at
    // 2026-04-01T23:59:00Z (Thu 08:59 JST) so the next fire is one week later.
    await vi.advanceTimersByTimeAsync(86_400_000 * 7 + 120_000);
    await vi.advanceTimersByTimeAsync(120_000);

    const entries = service.getEntries();
    const weekly = entries.find((entry) => entry.id === "weekly-1");
    expect(weekly?.enabled).toBe(true);

    service.stop();
  });

  it("writes the disabled state back to disk after a one-shot fires", async () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        entries: [
          {
            id: "oneshot-1",
            channelId: "channel-1",
            message: "単発告知",
            oneShotDate: "2026-04-02",
            hour: 9,
            minute: 0,
            enabled: true,
          },
        ],
      }),
      "utf8",
    );

    const send = vi.fn(async () => undefined);
    const client = { channels: { fetch: vi.fn() } } as unknown as Parameters<
      typeof createScheduledAnnouncementsService
    >[0];
    const resolver = vi.fn(async () => makeSendable(send)) as unknown as ChannelResolver;

    const service = createScheduledAnnouncementsService(client, {
      loadOptions: { filePath },
      resolveChannel: resolver,
    });

    service.start();

    await vi.advanceTimersByTimeAsync(120_000);
    await vi.advanceTimersByTimeAsync(120_000);

    const reloaded = loadScheduledAnnouncements({ filePath });
    expect(reloaded.entries[0]?.enabled).toBe(false);

    service.stop();
  });
});
