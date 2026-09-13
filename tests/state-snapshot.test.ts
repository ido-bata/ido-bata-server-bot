import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  decryptBuffer,
  encryptBuffer,
  resolveEncryptionKey,
} from "../src/features/state-snapshot/encryption.js";
import {
  applyRetentionPlan,
  classifySnapshot,
  isoWeekKeyOfDate,
  planRetention,
} from "../src/features/state-snapshot/retention.js";
import { getNextSnapshotStartAt } from "../src/features/state-snapshot/schedule.js";
import {
  buildSnapshotId,
  createSnapshot,
  ensureSnapshotDir,
  listSnapshots,
  readSnapshotMetadata,
  restoreSnapshot,
  type SnapshotFileEntry,
  type SnapshotMetadata,
} from "../src/features/state-snapshot/snapshot.js";
import {
  createCompositeUploader,
  createGitHubBranchUploader,
  createNoopUploader,
} from "../src/features/state-snapshot/uploaders.js";

function makeKeyHex(): string {
  return randomBytes(32).toString("hex");
}

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("state-snapshot encryption", () => {
  it("round-trips a payload with the correct key", () => {
    const key = resolveEncryptionKey(makeKeyHex());
    const plaintext = Buffer.from("hello world", "utf8");
    const encrypted = encryptBuffer(plaintext, key);
    const decrypted = decryptBuffer(encrypted, key);
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it("rejects decryption with the wrong key", () => {
    const correct = resolveEncryptionKey(makeKeyHex());
    const wrong = resolveEncryptionKey(makeKeyHex());
    const plaintext = Buffer.from("secret payload", "utf8");
    const encrypted = encryptBuffer(plaintext, correct);

    expect(() => decryptBuffer(encrypted, wrong)).toThrow();
  });

  it("rejects tampered ciphertext", () => {
    const key = resolveEncryptionKey(makeKeyHex());
    const plaintext = Buffer.from("another secret", "utf8");
    const encrypted = encryptBuffer(plaintext, key);
    const tampered = Buffer.from(encrypted.ciphertext);
    tampered[0] = tampered[0]! ^ 0xff;

    expect(() => decryptBuffer({ ...encrypted, ciphertext: tampered }, key)).toThrow();
  });

  it("rejects malformed encryption keys", () => {
    expect(() => resolveEncryptionKey(undefined)).toThrow(/required/);
    expect(() => resolveEncryptionKey("not-hex")).toThrow(/hex/);
    expect(() => resolveEncryptionKey("00")).toThrow(/32 bytes/);
  });
});

describe("state-snapshot scheduler", () => {
  it("schedules today when the current time is before the JST snapshot hour", () => {
    const nextStartAt = getNextSnapshotStartAt(new Date("2026-04-01T00:30:00+09:00"), 3, 0);
    expect(nextStartAt.toISOString()).toBe("2026-03-31T18:00:00.000Z");
  });

  it("schedules tomorrow when the current time is past today's JST snapshot hour", () => {
    const nextStartAt = getNextSnapshotStartAt(new Date("2026-04-01T05:00:00+09:00"), 3, 0);
    expect(nextStartAt.toISOString()).toBe("2026-04-01T18:00:00.000Z");
  });
});

describe("state-snapshot create + restore", () => {
  let workDir: string;
  let snapshotDir: string;
  let sourceDir: string;
  let sourcePath: string;
  let missingPath: string;
  const hexKey = makeKeyHex();

  beforeEach(() => {
    workDir = createTempDir("state-snap-");
    snapshotDir = join(workDir, "snapshots");
    sourceDir = join(workDir, "sources");
    mkdirSync(sourceDir, { recursive: true });
    sourcePath = join(sourceDir, "bot.db");
    missingPath = join(sourceDir, "missing.json");
    writeFileSync(sourcePath, Buffer.from("select 1;"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("writes a file with the expected extension and round-trips data", async () => {
    const metadata = await createSnapshot(
      { snapshotDir, sourcePaths: [sourcePath] },
      hexKey,
      new Date("2026-04-01T03:00:00+09:00"),
    );

    expect(metadata.path.endsWith(".snap.enc")).toBe(true);
    expect(metadata.files[0]).toMatchObject({ missing: false, path: sourcePath });

    const restoreDir = join(workDir, "restore");
    const result = await restoreSnapshot(metadata.path, hexKey, { outputDir: restoreDir });
    expect(result.files).toHaveLength(1);
    expect(result.manifest.createdAt).toBe("2026-03-31T18:00:00.000Z");
  });

  it("marks missing sources as `missing` but still writes a valid snapshot", async () => {
    const metadata = await createSnapshot(
      { snapshotDir, sourcePaths: [sourcePath, missingPath] },
      hexKey,
      new Date("2026-04-01T03:00:00+09:00"),
    );

    const restored = readSnapshotMetadata(metadata.path, hexKey);
    expect(restored.files.map((file) => file.path)).toEqual([sourcePath, missingPath]);
    expect(restored.files[0]?.missing).toBe(false);
    expect(restored.files[1]?.missing).toBe(true);
  });

  it("fails to restore with the wrong key", async () => {
    const metadata = await createSnapshot({ snapshotDir, sourcePaths: [sourcePath] }, hexKey);
    await expect(
      restoreSnapshot(metadata.path, makeKeyHex(), { outputDir: join(workDir, "restore") }),
    ).rejects.toThrow();
  });

  it("refuses to restore a tampered snapshot", async () => {
    const metadata = await createSnapshot({ snapshotDir, sourcePaths: [sourcePath] }, hexKey);
    const buffer = readFileSync(metadata.path);
    buffer[64] = buffer[64]! ^ 0xff;
    writeFileSync(metadata.path, buffer);

    await expect(
      restoreSnapshot(metadata.path, hexKey, { outputDir: join(workDir, "restore") }),
    ).rejects.toThrow();
  });

  it("builds snapshot IDs from JST-formatted timestamps", () => {
    const id = buildSnapshotId(new Date("2026-04-01T03:00:00+09:00"));
    expect(id).toMatch(/^2026-04-01-03-00-00$/);
  });

  it("lists snapshots newest-first", async () => {
    await createSnapshot(
      { snapshotDir, sourcePaths: [sourcePath] },
      hexKey,
      new Date("2026-04-01T03:00:00+09:00"),
    );
    await createSnapshot(
      { snapshotDir, sourcePaths: [sourcePath] },
      hexKey,
      new Date("2026-04-02T03:00:00+09:00"),
    );
    const all = listSnapshots(snapshotDir, hexKey);
    expect(all).toHaveLength(2);
    expect(all[0]?.createdAt > all[1]?.createdAt).toBe(true);
  });

  it("creates the snapshot directory on demand", async () => {
    const nestedDir = join(workDir, "nested", "deep");
    expect(() => ensureSnapshotDir(nestedDir)).not.toThrow();
    const metadata = await createSnapshot(
      { snapshotDir: nestedDir, sourcePaths: [sourcePath] },
      hexKey,
    );
    expect(metadata.path.startsWith(nestedDir)).toBe(true);
  });
});

describe("state-snapshot retention", () => {
  function makeMetadata(id: string, createdAt: string, baseDir: string) {
    return {
      createdAt,
      files: [] as SnapshotFileEntry[],
      id,
      path: join(baseDir, `${id}.snap.enc`),
    };
  }

  it("classifies snapshots by age relative to a reference date", () => {
    const referenceDate = new Date("2026-04-30T00:00:00Z");
    const baseDir = "/tmp/snapshots";
    expect(
      classifySnapshot(makeMetadata("d", "2026-04-29T00:00:00Z", baseDir), referenceDate).bucket,
    ).toBe("daily");
    expect(
      classifySnapshot(makeMetadata("w", "2026-04-20T00:00:00Z", baseDir), referenceDate).bucket,
    ).toBe("weekly");
    expect(
      classifySnapshot(makeMetadata("m", "2026-03-15T00:00:00Z", baseDir), referenceDate).bucket,
    ).toBe("monthly");
  });

  it("keeps the configured number of dailies and evicts the rest", () => {
    const referenceDate = new Date("2026-04-30T00:00:00Z");
    const baseDir = "/tmp/snapshots";
    const snapshots = [
      makeMetadata("d1", "2026-04-28T00:00:00Z", baseDir),
      makeMetadata("d2", "2026-04-27T00:00:00Z", baseDir),
      makeMetadata("d3", "2026-04-26T00:00:00Z", baseDir),
      makeMetadata("d4", "2026-04-25T00:00:00Z", baseDir),
      makeMetadata("d5", "2026-04-24T00:00:00Z", baseDir),
    ];

    const plan = planRetention(
      snapshots,
      { dailyRetention: 3, monthlyRetention: 12, weeklyRetention: 4 },
      referenceDate,
    );

    expect(plan.keep.map((entry) => entry.id).sort()).toEqual(["d1", "d2", "d3"]);
    expect(plan.delete.map((entry) => entry.id).sort()).toEqual(["d4", "d5"]);
  });

  it("keeps one representative per ISO week in the weekly tier", () => {
    const referenceDate = new Date("2026-04-30T00:00:00Z");
    const baseDir = "/tmp/snapshots";
    // Five consecutive days in the weekly band (7-30 days old). Without
    // generational selection all five would be candidates, but only one
    // snapshot per ISO week should survive.
    const snapshots = [
      makeMetadata("w-mon", "2026-04-20T00:00:00Z", baseDir), // ISO week 2026-W17
      makeMetadata("w-tue", "2026-04-21T00:00:00Z", baseDir),
      makeMetadata("w-wed", "2026-04-22T00:00:00Z", baseDir),
      makeMetadata("w-thu", "2026-04-23T00:00:00Z", baseDir),
      makeMetadata("w-sat", "2026-04-11T00:00:00Z", baseDir), // ISO week 2026-W15
    ];

    const plan = planRetention(
      snapshots,
      { dailyRetention: 7, monthlyRetention: 12, weeklyRetention: 4 },
      referenceDate,
    );

    const keptIds = plan.keep.map((entry) => entry.id).sort();
    expect(keptIds).toEqual(["w-sat", "w-thu"]);
    expect(plan.delete.map((entry) => entry.id).sort()).toEqual(["w-mon", "w-tue", "w-wed"]);
  });

  it("keeps one representative per calendar month in the monthly tier", () => {
    const referenceDate = new Date("2026-04-30T00:00:00Z");
    const baseDir = "/tmp/snapshots";
    // 13 days across 13 different months in the monthly band (>= 30 days).
    const snapshots = [
      makeMetadata("m-25-04", "2025-04-15T00:00:00Z", baseDir),
      makeMetadata("m-25-05", "2025-05-15T00:00:00Z", baseDir),
      makeMetadata("m-25-06", "2025-06-15T00:00:00Z", baseDir),
      makeMetadata("m-25-07", "2025-07-15T00:00:00Z", baseDir),
      makeMetadata("m-25-08", "2025-08-15T00:00:00Z", baseDir),
      makeMetadata("m-25-09", "2025-09-15T00:00:00Z", baseDir),
      makeMetadata("m-25-10", "2025-10-15T00:00:00Z", baseDir),
      makeMetadata("m-25-11", "2025-11-15T00:00:00Z", baseDir),
      makeMetadata("m-25-12", "2025-12-15T00:00:00Z", baseDir),
      makeMetadata("m-26-01", "2026-01-15T00:00:00Z", baseDir),
      makeMetadata("m-26-02", "2026-02-15T00:00:00Z", baseDir),
      makeMetadata("m-26-03", "2026-03-15T00:00:00Z", baseDir),
      makeMetadata("m-25-04b", "2025-04-20T00:00:00Z", baseDir), // same month as m-25-04
    ];

    const plan = planRetention(
      snapshots,
      { dailyRetention: 7, monthlyRetention: 12, weeklyRetention: 4 },
      referenceDate,
    );

    // m-25-04 + m-25-04b collapse into a single month representative (the most
    // recent, m-25-04b). m-26-03 is the 12th and final monthly survivor; the
    // 13th distinct month (m-25-04) is evicted.
    const keptIds = plan.keep.map((entry) => entry.id).sort();
    expect(keptIds).toEqual(
      [
        "m-25-04b",
        "m-25-05",
        "m-25-06",
        "m-25-07",
        "m-25-08",
        "m-25-09",
        "m-25-10",
        "m-25-11",
        "m-25-12",
        "m-26-01",
        "m-26-02",
        "m-26-03",
      ].sort(),
    );
    expect(plan.delete.map((entry) => entry.id)).toEqual(["m-25-04"]);
  });

  it("derives ISO week keys consistently for boundary dates", () => {
    expect(isoWeekKeyOfDate(new Date("2026-01-01T00:00:00Z"))).toBe("2026-W01");
    expect(isoWeekKeyOfDate(new Date("2026-04-20T00:00:00Z"))).toBe("2026-W17");
    // 2025-12-31 (Wednesday) belongs to ISO week 1 of 2026.
    expect(isoWeekKeyOfDate(new Date("2025-12-31T00:00:00Z"))).toBe("2026-W01");
  });

  it("deletes snapshot files when applying the plan", async () => {
    const workDir = createTempDir("retention-");
    const referenceDate = new Date("2026-04-30T00:00:00Z");

    const snapshots = ["d1", "d2", "d3", "d4"].map((id, index) => {
      const filePath = join(workDir, `${id}.snap.enc`);
      writeFileSync(filePath, "x");
      const createdAt = new Date(referenceDate.getTime() - (index + 1) * 86_400_000).toISOString();
      return makeMetadata(id, createdAt, workDir);
    });

    const plan = planRetention(
      snapshots,
      { dailyRetention: 2, monthlyRetention: 12, weeklyRetention: 4 },
      referenceDate,
    );

    expect(plan.delete.map((entry) => entry.id).sort()).toEqual(["d3", "d4"]);

    await applyRetentionPlan(plan);
    for (const deleted of plan.delete) {
      expect(existsSync(deleted.path)).toBe(false);
    }
    for (const kept of plan.keep) {
      expect(existsSync(kept.path)).toBe(true);
    }

    rmSync(workDir, { recursive: true, force: true });
  });

  it("respects dry-run mode for retention application", async () => {
    const workDir = createTempDir("retention-dry-");
    const referenceDate = new Date("2026-04-30T00:00:00Z");
    const filePath = join(workDir, "d1.snap.enc");
    writeFileSync(filePath, "x");
    const snapshots = [
      makeMetadata("d1", new Date(referenceDate.getTime() - 5 * 86_400_000).toISOString(), workDir),
    ];

    const plan = planRetention(
      snapshots,
      { dailyRetention: 0, monthlyRetention: 0, weeklyRetention: 0 },
      referenceDate,
    );

    await applyRetentionPlan(plan, { dryRun: true });
    expect(existsSync(filePath)).toBe(true);

    rmSync(workDir, { recursive: true, force: true });
  });
});

describe("state-snapshot uploaders", () => {
  function makeMetadata(path: string): SnapshotMetadata {
    return {
      createdAt: new Date().toISOString(),
      files: [],
      id: path,
      path,
    };
  }

  it("noop uploader never throws", async () => {
    const uploader = createNoopUploader();
    await expect(uploader.upload(makeMetadata("/tmp/nope.snap.enc"))).resolves.toBeUndefined();
  });

  it("composite uploader aggregates names", () => {
    const uploader = createCompositeUploader([
      createNoopUploader(),
      createGitHubBranchUploader({
        branch: "state-snapshots",
        remote: "origin",
        workdir: "/tmp",
      }),
    ]);
    expect(uploader.name).toContain("noop");
    expect(uploader.name).toContain("github-branch");
  });

  it("composite uploader raises when every uploader fails", async () => {
    const failing = {
      name: "always-fails",
      upload: () => Promise.reject(new Error("boom")),
    };
    const composite = createCompositeUploader([failing]);
    await expect(
      composite.upload({
        createdAt: new Date().toISOString(),
        files: [],
        id: "x",
        path: "/tmp/missing.snap.enc",
      }),
    ).rejects.toThrow(/All snapshot uploaders failed|boom/i);
  });

  it("composite uploader tolerates partial failures", async () => {
    let goodCalled = false;
    const failing = {
      name: "always-fails",
      upload: () => Promise.reject(new Error("boom")),
    };
    const good = {
      name: "good",
      upload: () => {
        goodCalled = true;
        return Promise.resolve();
      },
    };
    const composite = createCompositeUploader([failing, good]);
    await expect(
      composite.upload({
        createdAt: new Date().toISOString(),
        files: [],
        id: "x",
        path: "/tmp/x.snap.enc",
      }),
    ).resolves.toBeUndefined();
    expect(goodCalled).toBe(true);
  });

  it("github-branch uploader throws when the snapshot file is missing", async () => {
    const uploader = createGitHubBranchUploader({
      branch: "state-snapshots",
      remote: "origin",
      workdir: "/tmp",
    });
    await expect(
      uploader.upload({
        createdAt: new Date().toISOString(),
        files: [],
        id: "x",
        path: "/nonexistent.snap.enc",
      }),
    ).rejects.toThrow(/no longer exists/);
  });
});
