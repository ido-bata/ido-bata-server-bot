import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearUserData } from "../../src/features/privacy/clear.js";
import * as birthday from "../../src/features/privacy/consumers/birthday.js";
import * as poll from "../../src/features/privacy/consumers/poll.js";
import * as reminder from "../../src/features/privacy/consumers/reminder.js";
import * as timekeeper from "../../src/features/privacy/consumers/timekeeper.js";

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "privacy-clear-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function seedTimekeeper(dir: string, userId: string): void {
  writeFileSync(
    join(dir, "data", "timekeeper-history.json"),
    JSON.stringify({ [userId]: ["2026-04-01"], other: ["2026-04-01"] }, null, 2),
    "utf8",
  );
}

function seedBirthday(dir: string, userId: string): void {
  writeFileSync(
    join(dir, "data", "birthdays.json"),
    JSON.stringify(
      {
        birthdays: {
          [userId]: { date: "2026-04-01", updatedAt: "2026-04-01T00:00:00Z", userId },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

function seedPoll(dir: string, userId: string): void {
  writeFileSync(
    join(dir, "data", "polls.json"),
    JSON.stringify(
      {
        version: 1,
        polls: [
          {
            id: "poll-1",
            creatorId: userId,
            votes: { [userId]: 0, other: 1 },
          },
          {
            id: "poll-2",
            creatorId: "other",
            votes: { [userId]: 0 },
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
}

function seedReminder(dir: string, userId: string): void {
  writeFileSync(
    join(dir, "data", "reminders.json"),
    JSON.stringify(
      {
        reminders: [
          {
            id: "r-1",
            userId,
            message: "hi",
            fireAt: "2030-01-01T00:00:00Z",
            createdAt: "2026-04-01T00:00:00Z",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
}

function setupDataDir(dir: string): void {
  mkdirSync(join(dir, "data"), { recursive: true });
}

describe("clearUserData aggregator", () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    const tmp = makeTempDir();
    dir = tmp.dir;
    cleanup = tmp.cleanup;
    setupDataDir(dir);
  });

  afterEach(() => {
    cleanup();
  });

  it("runs every consumer and reports ok when all succeed", async () => {
    const userId = "user-1";
    seedTimekeeper(dir, userId);
    seedBirthday(dir, userId);
    seedPoll(dir, userId);
    seedReminder(dir, userId);

    // Override cwd so the adapters see our seeded files.
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      const report = await clearUserData(userId);
      expect(report.ok).toBe(true);
      expect(report.results.map((r) => r.consumer)).toEqual([
        "timekeeper-history",
        "birthday",
        "poll",
        "reminder",
        "state-snapshot",
      ]);
      for (const result of report.results) {
        expect(result.ok).toBe(true);
      }
      // The user's entries were actually removed from each seeded file.
      const { readFileSync } = await import("node:fs");
      const tk = JSON.parse(
        readFileSync(join(dir, "data", "timekeeper-history.json"), "utf8"),
      ) as Record<string, string[]>;
      expect(tk["user-1"]).toBeUndefined();
      expect(tk.other).toEqual(["2026-04-01"]);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("returns ok:false when one consumer fails (timekeeper file is a directory)", async () => {
    // Force the timekeeper adapter to fail by replacing the file path with a
    // directory. readFileSync throws EISDIR and the adapter surfaces ok:false.
    mkdirSync(join(dir, "data", "timekeeper-history.json"));
    seedPoll(dir, "user-2");
    seedReminder(dir, "user-2");

    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      const report = await clearUserData("user-2");
      expect(report.ok).toBe(false);
      const failed = report.results.find((r) => !r.ok);
      expect(failed?.consumer).toBe("timekeeper-history");
      expect(failed?.error).toBeTruthy();
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("isolates a single consumer failure to ok:false overall (poll file is a directory)", async () => {
    // The other adapters can succeed against the missing files; the poll
    // adapter alone fails because its file is a directory.
    mkdirSync(join(dir, "data", "polls.json"));
    seedTimekeeper(dir, "user-4");
    seedBirthday(dir, "user-4");
    seedReminder(dir, "user-4");

    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      const report = await clearUserData("user-4");
      expect(report.ok).toBe(false);
      expect(report.results.find((r) => r.consumer === "poll")?.ok).toBe(false);
      // The other consent-gated adapters succeeded.
      expect(report.results.find((r) => r.consumer === "timekeeper-history")?.ok).toBe(true);
      expect(report.results.find((r) => r.consumer === "birthday")?.ok).toBe(true);
      expect(report.results.find((r) => r.consumer === "reminder")?.ok).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("includes the user-supplied subjectId in the report", async () => {
    const report = await clearUserData("user-3");
    expect(report.subjectId).toBe("user-3");
  });

  it("calls ConsentService.clear when a service is provided and reports its outcome", async () => {
    // Regression test for PR #101 review P1 #3 — `/privacy delete` previously
    // only ran consumer adapters, leaving `data/consent.json` grants in
    // place and never emitting the `clear` event the snapshot scheduler
    // subscribes to.
    const userId = "user-1";
    const consentService = {
      clear: vi.fn(async () => ({
        results: [{ scope: "profile" as const, ok: true }],
      })),
    };
    const report = await clearUserData(userId, {
      consentService: consentService as unknown as Parameters<
        typeof clearUserData
      >[1] extends infer T
        ? T extends { consentService?: infer S }
          ? S
          : never
        : never,
    });
    expect(consentService.clear).toHaveBeenCalledWith(userId);
    const consentSlot = report.results.find((r) => r.consumer === "consent-registry");
    expect(consentSlot?.ok).toBe(true);
    expect(report.ok).toBe(true);
  });

  it("reports ok:false when ConsentService.clear fails", async () => {
    const consentService = {
      clear: vi.fn(async () => ({
        results: [{ scope: "profile" as const, ok: false, error: "disk full" }],
      })),
    };
    const report = await clearUserData("user-1", {
      consentService: consentService as unknown as Parameters<
        typeof clearUserData
      >[1] extends infer T
        ? T extends { consentService?: infer S }
          ? S
          : never
        : never,
    });
    const consentSlot = report.results.find((r) => r.consumer === "consent-registry");
    expect(consentSlot?.ok).toBe(false);
    expect(consentSlot?.error).toContain("disk full");
    expect(report.ok).toBe(false);
  });

  it("exports the expected adapter entry points", () => {
    expect(typeof timekeeper.deleteUserData).toBe("function");
    expect(typeof birthday.deleteUserData).toBe("function");
    expect(typeof poll.deleteUserData).toBe("function");
    expect(typeof reminder.deleteUserData).toBe("function");
  });

  it("returns ok:true on a clean run with no seeded data", async () => {
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      const report = await clearUserData("user-empty");
      expect(report.ok).toBe(true);
      for (const result of report.results) {
        expect(result.ok).toBe(true);
      }
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("clears the consent registry BEFORE the consumer loop so the post-clear state snapshot does not retain the grant (P1)", async () => {
    // The state-snapshot adapter takes a fresh snapshot via
    // `takeFreshSnapshot` while looping through consumers. If the
    // consent registry is NOT cleared first, that snapshot bakes the
    // about-to-be-deleted grant onto disk and a restore would revive it.
    // Verify ordering: consent clear runs first, then state-snapshot
    // captures the cleared state, then any other consumer runs.
    const userId = "user-ordering";
    seedTimekeeper(dir, userId);
    seedBirthday(dir, userId);
    seedPoll(dir, userId);
    seedReminder(dir, userId);
    // Seed a pre-existing snapshot file so the consumer path actually
    // reaches `takeFreshSnapshot` — without files the adapter
    // short-circuits and ordering can't be observed end-to-end.
    mkdirSync(join(dir, "data", "snapshots"), { recursive: true });
    writeFileSync(join(dir, "data", "snapshots", "old.snap.enc"), "fake", "utf8");

    const order: string[] = [];
    const consentService = {
      // Track when the consent clear happens relative to consumers.
      // It MUST run before state-snapshot's takeFreshSnapshot to avoid
      // baking the grant onto disk.
      clear: vi.fn(async (subjectId: string) => {
        order.push(`consent:${subjectId}`);
        return { ok: true, results: [{ ok: true as const, scope: "profile" as const }] };
      }),
    };
    const takeFreshSnapshot = vi.fn(async () => {
      order.push("snapshot:fresh");
      // Return a path inside the seeded snapshot dir so the retention
      // pass treats this file as the one to keep.
      return join(dir, "data", "snapshots", "fresh.snap.enc");
    });

    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      await clearUserData(userId, {
        consentService: consentService as unknown as Parameters<
          typeof clearUserData
        >[1] extends infer T
          ? T extends { consentService?: infer S }
            ? S
            : never
          : never,
        takeFreshSnapshot,
      });
    } finally {
      process.chdir(originalCwd);
    }

    const consentIdx = order.findIndex((entry) => entry.startsWith("consent:"));
    const snapshotIdx = order.indexOf("snapshot:fresh");
    expect(consentIdx).toBeGreaterThanOrEqual(0);
    expect(snapshotIdx).toBeGreaterThanOrEqual(0);
    expect(consentIdx).toBeLessThan(snapshotIdx);
    expect(consentService.clear).toHaveBeenCalledTimes(1);
    expect(takeFreshSnapshot).toHaveBeenCalledTimes(1);
  });
});
