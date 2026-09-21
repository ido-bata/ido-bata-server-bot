/**
 * Privacy consumer invariants:
 *   - ENOENT (no persisted file) is success — there is nothing to remove.
 *   - Read / parse / schema / write failure surfaces as `{ ok: false, error }`
 *     so the aggregator (`src/features/privacy/clear.ts`) can mark the
 *     whole `/privacy delete` as a partial failure. A corrupted store
 *     must NEVER be silently swallowed into `{ ok: true }`.
 *   - Successful deletes do not corrupt the file (round-trip parse).
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deleteUserData as deleteBirthday } from "../src/features/privacy/consumers/birthday.js";
import { deleteUserData as deletePoll } from "../src/features/privacy/consumers/poll.js";
import { deleteUserData as deleteReminder } from "../src/features/privacy/consumers/reminder.js";
import { deleteUserData as deleteTimekeeper } from "../src/features/privacy/consumers/timekeeper.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "privacy-"));
}

describe("privacy consumer delete adapters", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  describe("timekeeper-history", () => {
    it("returns ok:true for a missing file (ENOENT is success)", async () => {
      const outcome = await deleteTimekeeper("u1", {
        filePath: join(workDir, "missing.json"),
      });
      expect(outcome).toEqual({ ok: true });
    });

    it("removes the user key when present and round-trips the file", async () => {
      const filePath = join(workDir, "history.json");
      writeFileSync(filePath, JSON.stringify({ u1: ["2026-09-21"], u2: ["2026-09-20"] }));
      const outcome = await deleteTimekeeper("u1", { filePath });
      expect(outcome).toEqual({ ok: true });
      const after = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, string[]>;
      expect(after).toEqual({ u2: ["2026-09-20"] });
    });

    it("returns ok:false (NOT silent success) for corrupted JSON", async () => {
      const filePath = join(workDir, "broken.json");
      writeFileSync(filePath, "{ not valid json");
      const outcome = await deleteTimekeeper("u1", { filePath });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toMatch(/parse failed|schema mismatch/);
      }
    });

    it("returns ok:false when the file is unreadable", async () => {
      const filePath = join(workDir, "locked.json");
      writeFileSync(filePath, JSON.stringify({ u1: ["x"] }));
      chmodSync(filePath, 0o000);
      const outcome = await deleteTimekeeper("u1", { filePath });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toMatch(/read failed|temp file open failed|rename failed/);
      }
      chmodSync(filePath, 0o600);
    });
  });

  describe("birthday", () => {
    it("removes only the target user from the birthdays record", async () => {
      const filePath = join(workDir, "birthdays.json");
      writeFileSync(
        filePath,
        JSON.stringify({
          birthdays: {
            u1: { date: "2000-01-01", updatedAt: "x", userId: "u1" },
            u2: { date: "2000-02-02", updatedAt: "y", userId: "u2" },
          },
        }),
      );
      const outcome = await deleteBirthday("u1", { filePath });
      expect(outcome).toEqual({ ok: true });
      const after = JSON.parse(readFileSync(filePath, "utf8")) as {
        birthdays: Record<string, { userId: string }>;
      };
      expect(Object.keys(after.birthdays)).toEqual(["u2"]);
    });

    it("returns ok:false (NOT silent success) for corrupted JSON", async () => {
      const filePath = join(workDir, "broken.json");
      writeFileSync(filePath, "garbage");
      const outcome = await deleteBirthday("u1", { filePath });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toMatch(/parse failed|schema mismatch/);
      }
    });
  });

  describe("poll", () => {
    it("removes the user's votes and drops polls they created", async () => {
      const filePath = join(workDir, "polls.json");
      // Match the canonical `pollStateFileSchema` shape so the privacy
      // adapter's Zod parse succeeds. A missing `version: 1` would cause
      // the schema check to reject the file before the deletion ran — see
      // PR #101 review (P1: poll adapter strips version).
      writeFileSync(
        filePath,
        JSON.stringify({
          version: 1,
          polls: [
            { id: "p1", creatorId: "u3", votes: { u1: 0, u2: 1 } },
            { id: "p2", creatorId: "u1", votes: { u4: 0 } },
            { id: "p3", creatorId: "u2", votes: { u1: 1 } },
          ],
        }),
      );
      const outcome = await deletePoll("u1", { filePath });
      expect(outcome).toEqual({ ok: true });
      const after = JSON.parse(readFileSync(filePath, "utf8")) as {
        version: number;
        polls: Array<{ id: string; creatorId: string; votes: Record<string, number> }>;
      };
      // The privacy adapter must preserve `version: 1` so the next poll
      // load doesn't reject the file as schema-mismatched.
      expect(after.version).toBe(1);
      // u1's created poll (p2) is dropped entirely.
      // p1 keeps u2's vote but u1's vote is removed.
      // p3 keeps u2 as creator but u1's vote is removed.
      expect(after.polls.map((poll) => poll.id).sort()).toEqual(["p1", "p3"]);
      expect(after.polls.find((poll) => poll.id === "p1")?.votes).toEqual({ u2: 1 });
      expect(after.polls.find((poll) => poll.id === "p3")?.votes).toEqual({});
    });

    it("preserves version: 1 round-trip on files that match the canonical shape", async () => {
      const filePath = join(workDir, "polls-versioned.json");
      writeFileSync(
        filePath,
        JSON.stringify({
          version: 1,
          polls: [{ id: "p1", creatorId: "u3", votes: {} }],
        }),
      );
      const outcome = await deletePoll("u3", { filePath });
      expect(outcome).toEqual({ ok: true });
      const after = JSON.parse(readFileSync(filePath, "utf8")) as {
        version: number;
        polls: unknown[];
      };
      // After deleting u3's poll the file should still load as
      // `version: 1, polls: []` — the version wrapper is mandatory.
      expect(after.version).toBe(1);
      expect(after.polls).toEqual([]);
    });

    it("returns ok:false (NOT silent success) for corrupted JSON", async () => {
      const filePath = join(workDir, "broken.json");
      writeFileSync(filePath, "garbage");
      const outcome = await deletePoll("u1", { filePath });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toMatch(/parse failed|schema mismatch/);
      }
    });
  });

  describe("reminder", () => {
    it("removes every reminder owned by the user and leaves others", async () => {
      const filePath = join(workDir, "reminders.json");
      writeFileSync(
        filePath,
        JSON.stringify({
          reminders: [
            { id: "r1", userId: "u1", message: "m1", fireAt: "x", createdAt: "y" },
            { id: "r2", userId: "u2", message: "m2", fireAt: "x", createdAt: "y" },
            { id: "r3", userId: "u1", message: "m3", fireAt: "x", createdAt: "y" },
          ],
        }),
      );
      const outcome = await deleteReminder("u1", { filePath });
      expect(outcome).toEqual({ ok: true });
      const after = JSON.parse(readFileSync(filePath, "utf8")) as {
        reminders: Array<{ id: string }>;
      };
      expect(after.reminders.map((reminder) => reminder.id)).toEqual(["r2"]);
    });

    it("returns ok:false (NOT silent success) for corrupted JSON", async () => {
      const filePath = join(workDir, "broken.json");
      writeFileSync(filePath, "garbage");
      const outcome = await deleteReminder("u1", { filePath });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toMatch(/parse failed|schema mismatch/);
      }
    });
  });
});
