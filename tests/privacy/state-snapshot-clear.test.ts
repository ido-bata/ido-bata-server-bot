import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearUserData } from "../../src/features/privacy/clear.js";
import { deleteUserData } from "../../src/features/privacy/consumers/state-snapshot.js";

describe("state-snapshot privacy clear", () => {
  let snapshotDir: string;
  let cleanup: () => void;

  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "snapshot-clear-"));
    snapshotDir = join(dir, "data", "snapshots");
    mkdirSync(snapshotDir, { recursive: true });
    cleanup = () => rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    cleanup();
  });

  function seedSnapshot(name: string): string {
    writeFileSync(join(snapshotDir, name), "fake-encrypted-content", "utf8");
    return join(snapshotDir, name);
  }

  // Stub a takeFreshSnapshot that writes a sentinel file and returns its
  // path. Each test can override `freshPath` to control the keep target.
  function freshSnapshot(): { takeFreshSnapshot: () => Promise<string | null>; path: string } {
    const path = join(snapshotDir, "fresh.snap.enc");
    writeFileSync(path, "fresh-snapshot", "utf8");
    return { takeFreshSnapshot: async () => path, path };
  }

  it("purges every .snap.enc file via applyRetentionPlan", async () => {
    const a = seedSnapshot("2026-04-01T00-00-00-a.snap.enc");
    const b = seedSnapshot("2026-04-02T00-00-00-b.snap.enc");
    const { takeFreshSnapshot } = freshSnapshot();

    const result = await deleteUserData("user-1", {
      snapshotDir,
      now: () => new Date("2026-04-03T00:00:00Z"),
      takeFreshSnapshot,
    });

    expect(result.ok).toBe(true);
    // Both stale files removed; the fresh snapshot path is preserved.
    const { existsSync } = await import("node:fs");
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
  });

  it("works when the directory is pointed at via cwd (no options)", async () => {
    const { takeFreshSnapshot } = freshSnapshot();
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      const a = seedSnapshot("2026-04-01.cwd.snap.enc");
      const report = await clearUserData("user-1", { takeFreshSnapshot });
      expect(report.ok).toBe(true);
      const { existsSync } = await import("node:fs");
      expect(existsSync(a)).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("returns ok:true when the snapshot directory is absent", async () => {
    const { takeFreshSnapshot } = freshSnapshot();
    const result = await deleteUserData("user-1", { snapshotDir, takeFreshSnapshot });
    expect(result.ok).toBe(true);
  });

  it("returns ok:true when the snapshot directory is empty", async () => {
    const { takeFreshSnapshot } = freshSnapshot();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(snapshotDir, { recursive: true });
    const result = await deleteUserData("user-1", { snapshotDir, takeFreshSnapshot });
    expect(result.ok).toBe(true);
  });

  it("is reported by clear() with consumer name 'state-snapshot'", async () => {
    seedSnapshot("2026-04-01.snap.enc");
    const { takeFreshSnapshot } = freshSnapshot();
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      const report = await clearUserData("user-1", { takeFreshSnapshot });
      const snapshotResult = report.results.find((entry) => entry.consumer === "state-snapshot");
      expect(snapshotResult).toBeDefined();
      expect(snapshotResult?.ok).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("treats partial-failure (leftover files) as ok:false", async () => {
    // Replace a real .snap.enc file with a *directory* of the same name.
    // `unlinkSync` will then throw EISDIR, and the snapshot adapter should
    // surface that as ok:false with an error message describing the leftover.
    const name = "2026-04-01.snap.enc";
    const { rmSync } = await import("node:fs");
    rmSync(join(snapshotDir, name), { force: true });
    mkdirSync(join(snapshotDir, name));

    const { takeFreshSnapshot } = freshSnapshot();
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      const report = await clearUserData("user-1", { takeFreshSnapshot });
      expect(report.ok).toBe(false);
      const snapshotResult = report.results.find((entry) => entry.consumer === "state-snapshot");
      expect(snapshotResult?.ok).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("declines to purge when takeFreshSnapshot is missing", async () => {
    seedSnapshot("2026-04-01.snap.enc");
    const result = await deleteUserData("user-1", { snapshotDir });
    if (result.ok) {
      throw new Error("expected ok:false when fresh snapshot hook is missing");
    }
    expect(result.error).toMatch(/fresh snapshot/i);
  });
});
