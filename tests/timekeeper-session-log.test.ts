import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSessionEngagement,
  loadSessionLog,
  markSessionInterrupted,
  recordCheckIn,
} from "../src/features/timekeeper/engagement.js";

function setCwd(path: string): () => void {
  const original = process.cwd();
  process.chdir(path);
  return () => process.chdir(original);
}

describe("timekeeper markSessionInterrupted", () => {
  let workspace: string;
  let restoreCwd: () => void;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "timekeeper-mark-"));
    restoreCwd = setCwd(workspace);
  });

  afterEach(() => {
    restoreCwd();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("persists attendance and appends a session-status record", () => {
    // Use 12:00 UTC so the JST date matches the calendar date in en-CA format.
    const session = createSessionEngagement("2026-04-01T12:00:00.000Z");
    recordCheckIn(session, "user-1", 2);
    recordCheckIn(session, "user-1", 4);

    markSessionInterrupted(session, { reason: "shutdown", status: "interrupted" });

    const historyPath = join(workspace, "data", "timekeeper-history.json");
    const logPath = join(workspace, "data", "timekeeper-sessions.json");

    expect(existsSync(historyPath)).toBe(true);
    const history = JSON.parse(readFileSync(historyPath, "utf8")) as Record<string, string[]>;
    expect(history["user-1"]).toEqual(["2026-04-01"]);

    expect(existsSync(logPath)).toBe(true);
    const log = JSON.parse(readFileSync(logPath, "utf8")) as Array<Record<string, unknown>>;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      id: "2026-04-01T12:00:00.000Z",
      reason: "shutdown",
      startedAt: "2026-04-01T12:00:00.000Z",
      status: "interrupted",
    });
    expect(typeof log[0]?.endedAt).toBe("string");
  });

  it("does not write attendance when there are no check-ins", () => {
    const session = createSessionEngagement("2026-04-01T12:00:00.000Z");

    markSessionInterrupted(session, { reason: "shutdown", status: "cancelled" });

    const historyPath = join(workspace, "data", "timekeeper-history.json");
    expect(existsSync(historyPath)).toBe(false);

    const log = loadSessionLog();
    expect(log).toHaveLength(1);
    expect(log[0]?.status).toBe("cancelled");
  });

  it("uses 'interrupted' as the default status", () => {
    const session = createSessionEngagement("2026-04-01T12:00:00.000Z");

    markSessionInterrupted(session);

    const log = loadSessionLog();
    expect(log[0]?.status).toBe("interrupted");
    expect(log[0]?.reason).toBeUndefined();
  });
});
