import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
} from "../src/features/state-snapshot/snapshot.js";

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

    expect(() =>
      decryptBuffer({ ...encrypted, ciphertext: tampered }, key),
    ).toThrow();
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
    expect(classifySnapshot(makeMetadata("d", "2026-04-29T00:00:00Z", baseDir), referenceDate).bucket).toBe(
      "daily",
    );
    expect(classifySnapshot(makeMetadata("w", "2026-04-20T00:00:00Z", baseDir), referenceDate).bucket).toBe(
      "weekly",
    );
    expect(classifySnapshot(makeMetadata("m", "2026-03-15T00:00:00Z", baseDir), referenceDate).bucket).toBe(
      "monthly",
    );
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

  it("deletes snapshot files when applying the plan", async () => {
    const workDir = createTempDir("retention-");
    const referenceDate = new Date("2026-04-30T00:00:00Z");

    const snapshots = ["d1", "d2", "d3", "d4"].map((id, index) => {
      const filePath = join(workDir, `${id}.snap.enc`);
      writeFileSync(filePath, "x");
      const createdAt = new Date(
        referenceDate.getTime() - (index + 1) * 86_400_000,
      ).toISOString();
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
      makeMetadata(
        "d1",
        new Date(referenceDate.getTime() - 5 * 86_400_000).toISOString(),
        workDir,
      ),
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