import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearUserData } from "../../src/features/privacy/clear.js";
import { deleteUserData } from "../../src/features/privacy/consumers/state-snapshot.js";
import { setStorageDriver } from "../../src/lib/storage/index.js";
import { createLocalFileStorage } from "../../src/lib/storage/local.js";
import type { StorageDriver } from "../../src/lib/storage/types.js";

describe("state-snapshot privacy clear", () => {
  let snapshotPrefix: string;
  let cleanup: () => void;
  let driver: StorageDriver;

  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "snapshot-clear-"));
    snapshotPrefix = "snapshots";
    driver = createLocalFileStorage({ root: dir });
    setStorageDriver(driver);
    cleanup = () => rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    setStorageDriver(null);
    cleanup();
  });

  async function seedSnapshot(name: string): Promise<string> {
    const key = `${snapshotPrefix}/${name}`;
    await driver.write(key, "fake-encrypted-content");
    return key;
  }

  // Stub a takeFreshSnapshot that writes a sentinel object and returns its
  // key. Each test can override the returned key to control the keep target.
  function freshSnapshot(): { takeFreshSnapshot: () => Promise<string | null>; path: string } {
    const path = `${snapshotPrefix}/fresh.snap.enc`;
    return { takeFreshSnapshot: async () => path, path };
  }

  it("purges every .snap.enc file via applyRetentionPlan", async () => {
    const a = await seedSnapshot("2026-04-01T00-00-00-a.snap.enc");
    const b = await seedSnapshot("2026-04-02T00-00-00-b.snap.enc");
    const { takeFreshSnapshot } = freshSnapshot();

    const result = await deleteUserData("user-1", {
      driver,
      now: () => new Date("2026-04-03T00:00:00Z"),
      snapshotPrefix,
      takeFreshSnapshot,
    });

    expect(result.ok).toBe(true);
    // Both stale objects removed; the fresh snapshot is preserved.
    expect(await driver.exists(a)).toBe(false);
    expect(await driver.exists(b)).toBe(false);
  });

  it("works with the default prefix (no options)", async () => {
    const { takeFreshSnapshot } = freshSnapshot();
    const a = await seedSnapshot("2026-04-01.default.snap.enc");
    const report = await clearUserData("user-1", { takeFreshSnapshot });
    expect(report.ok).toBe(true);
    expect(await driver.exists(a)).toBe(false);
  });

  it("returns ok:true when the snapshot prefix is empty", async () => {
    const { takeFreshSnapshot } = freshSnapshot();
    const result = await deleteUserData("user-1", { driver, snapshotPrefix, takeFreshSnapshot });
    expect(result.ok).toBe(true);
  });

  it("is reported by clear() with consumer name 'state-snapshot'", async () => {
    await seedSnapshot("2026-04-01.snap.enc");
    const { takeFreshSnapshot } = freshSnapshot();
    const report = await clearUserData("user-1", { takeFreshSnapshot });
    const snapshotResult = report.results.find((entry) => entry.consumer === "state-snapshot");
    expect(snapshotResult).toBeDefined();
    expect(snapshotResult?.ok).toBe(true);
  });

  it("treats partial-failure (leftover objects) as ok:false", async () => {
    // A storage backend whose delete silently fails leaves the object
    // behind. The adapter must surface that as ok:false instead of
    // claiming the snapshots were purged.
    await seedSnapshot("2026-04-01.snap.enc");
    const failingDriver: StorageDriver = {
      compareAndSwap: driver.compareAndSwap.bind(driver),
      delete: async () => {
        throw new Error("delete failed");
      },
      exists: driver.exists.bind(driver),
      kind: driver.kind,
      list: driver.list.bind(driver),
      move: driver.move.bind(driver),
      probeConditionalWrites: driver.probeConditionalWrites.bind(driver),
      read: driver.read.bind(driver),
      readText: driver.readText.bind(driver),
      readVersioned: driver.readVersioned.bind(driver),
      write: driver.write.bind(driver),
      writeExclusive: driver.writeExclusive.bind(driver),
    };
    setStorageDriver(failingDriver);

    const { takeFreshSnapshot } = freshSnapshot();
    const report = await clearUserData("user-1", { takeFreshSnapshot });
    expect(report.ok).toBe(false);
    const snapshotResult = report.results.find((entry) => entry.consumer === "state-snapshot");
    expect(snapshotResult?.ok).toBe(false);
  });

  it("declines to purge when takeFreshSnapshot is missing", async () => {
    await seedSnapshot("2026-04-01.snap.enc");
    const result = await deleteUserData("user-1", { driver, snapshotPrefix });
    if (result.ok) {
      throw new Error("expected ok:false when fresh snapshot hook is missing");
    }
    expect(result.error).toMatch(/fresh snapshot/i);
  });
});
