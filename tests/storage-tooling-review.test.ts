import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  appendDeletionRecord,
  DELETION_LEDGER_KEY,
  digestSubjectId,
  readDeletionLedgerState,
} from "../src/lib/storage/deletions.js";
import { createLocalFileStorage } from "../src/lib/storage/local.js";
import type { StorageDriver } from "../src/lib/storage/types.js";
import { createU3Storage } from "../src/lib/storage/u3.js";
import {
  backupStorage,
  exportStorage,
  importStorage,
  verifyStorage,
} from "../src/scripts/storage-migrate.js";
import { type FakeS3Server, startFakeS3Server } from "./helpers/fake-s3.js";

const LEDGER_KEY = "review-ledger-key-0123456789";

/**
 * Regression tests for the second review round (Issue #121):
 *
 * - the export source must not be pinned to the local filesystem
 * - a daily backup must be repeatable and must verify the bucket it wrote
 * - the deletion ledger must not lose, corrupt or silently ignore records
 * - a restore without the ledger key must not report success
 */
describe("storage tooling: export source, repeatable backup, ledger safety", () => {
  let server: FakeS3Server;
  let primary: StorageDriver;
  let backupBucket: StorageDriver;
  let restoreBucket: StorageDriver;
  let workDir: string;

  beforeAll(async () => {
    process.env.DELETION_LEDGER_KEY = LEDGER_KEY;
    server = await startFakeS3Server();
    primary = createU3Storage({
      accessKeyId: "AKTEST",
      bucket: "primary-bucket",
      endpoint: server.endpoint,
      region: "eu",
      secretAccessKey: "secret",
    });
    backupBucket = createU3Storage({
      accessKeyId: "AKTEST",
      bucket: "backup-bucket",
      endpoint: server.endpoint,
      region: "eu",
      secretAccessKey: "secret",
    });
    restoreBucket = createU3Storage({
      accessKeyId: "AKTEST",
      bucket: "restore-bucket",
      endpoint: server.endpoint,
      region: "eu",
      secretAccessKey: "secret",
    });
    workDir = mkdtempSync(join(tmpdir(), "storage-review-"));
  });

  afterAll(async () => {
    await server.close();
    delete process.env.DELETION_LEDGER_KEY;
    rmSync(workDir, { recursive: true, force: true });
  });

  afterEach(() => {
    process.env.DELETION_LEDGER_KEY = LEDGER_KEY;
  });

  it("exports from the object backend, not only from the local directory", async () => {
    await primary.write("consent.json", '{"records":[]}');
    const outDir = join(workDir, "export-from-bucket");
    mkdirSync(outDir, { recursive: true });

    const manifest = await exportStorage({ outDir, source: primary });

    expect(manifest.entries.map((entry) => entry.key)).toContain("consent.json");
    const manifestOnDisk = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8")) as {
      entries: { key: string }[];
    };
    expect(manifestOnDisk.entries.map((entry) => entry.key)).toContain("consent.json");
  });

  it("runs the same backup twice and verifies the bucket it wrote", async () => {
    await primary.write("timekeeper-history.json", '{"user-1":["2026-11-01"]}');
    const firstDir = join(workDir, "backup-run-1");
    const secondDir = join(workDir, "backup-run-2");
    mkdirSync(firstDir, { recursive: true });
    mkdirSync(secondDir, { recursive: true });

    const first = await backupStorage({
      exportDir: firstDir,
      source: primary,
      target: backupBucket,
    });
    expect(first.imported).toBeGreaterThan(0);
    expect(first.missing).toEqual([]);
    expect(first.mismatched).toEqual([]);

    // The second run must succeed as well — a daily backup overwrites the
    // previous copy instead of failing on "object already exists".
    const second = await backupStorage({
      exportDir: secondDir,
      source: primary,
      target: backupBucket,
    });
    expect(second.missing).toEqual([]);
    expect(second.mismatched).toEqual([]);
    expect(await backupBucket.readText("timekeeper-history.json")).toBe(
      '{"user-1":["2026-11-01"]}',
    );
  });

  it("restores the backup into an empty bucket and verifies the final state", async () => {
    const backupDir = join(workDir, "backup-for-restore");
    mkdirSync(backupDir, { recursive: true });
    await backupStorage({ exportDir: backupDir, source: primary, target: backupBucket });

    const restoreDir = join(workDir, "restore-from-backup");
    mkdirSync(restoreDir, { recursive: true });
    const manifest = await exportStorage({ outDir: restoreDir, source: backupBucket });
    expect(manifest.entries.length).toBeGreaterThan(0);

    const report = await importStorage({
      allowOverwrite: true,
      dir: restoreDir,
      target: restoreBucket,
    });
    expect(report.imported).toBe(manifest.entries.length);

    const verification = await verifyStorage({ dir: restoreDir, target: restoreBucket });
    expect(verification.missing).toEqual([]);
    expect(verification.mismatched).toEqual([]);
    expect(verification.verified).toBe(manifest.entries.length);
  });

  it("refuses to restore without the ledger key instead of reporting success", async () => {
    const dir = join(workDir, "export-without-key");
    mkdirSync(dir, { recursive: true });
    await exportStorage({ outDir: dir, source: primary });

    delete process.env.DELETION_LEDGER_KEY;
    await expect(
      importStorage({ allowOverwrite: true, dir, target: restoreBucket }),
    ).rejects.toThrow(/DELETION_LEDGER_KEY/);

    // The explicit override is the only way to continue.
    const report = await importStorage({
      allowMissingLedger: true,
      allowOverwrite: true,
      dir,
      target: restoreBucket,
    });
    expect(report.ledgerStatus).toBe("missing");
  });

  it("refuses to restore when the live deletion ledger is corrupt", async () => {
    const dir = join(workDir, "export-corrupt-ledger");
    mkdirSync(dir, { recursive: true });
    await exportStorage({ outDir: dir, source: primary });

    const corruptTarget = createLocalFileStorage({
      root: mkdtempSync(join(tmpdir(), "storage-review-corrupt-")),
    });
    await corruptTarget.write(DELETION_LEDGER_KEY, "{not json");

    await expect(
      importStorage({ allowOverwrite: true, dir, target: corruptTarget }),
    ).rejects.toThrow(/deletion ledger/);
  });

  it("keeps every record when deletions are appended concurrently", async () => {
    const driver = createLocalFileStorage({
      root: mkdtempSync(join(tmpdir(), "storage-review-concurrent-")),
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        appendDeletionRecord(driver, {
          at: new Date(2026, 0, 1, 0, 0, index).toISOString(),
          complete: true,
          digest: digestSubjectId(`user-${index}`, LEDGER_KEY),
        }),
      ),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    const state = await readDeletionLedgerState(driver);
    expect(state.status).toBe("ok");
    if (state.status === "ok") {
      expect(state.ledger.records).toHaveLength(8);
    }
  });

  it("reports a corrupt ledger instead of reading it as empty", async () => {
    const driver = createLocalFileStorage({
      root: mkdtempSync(join(tmpdir(), "storage-review-ledger-state-")),
    });
    await driver.write(DELETION_LEDGER_KEY, '{"schemaVersion":1,"records":[{"digest":"x"}]}');

    const state = await readDeletionLedgerState(driver);
    expect(state.status).toBe("corrupt");
  });

  it("reports a missing ledger as missing, not as an empty one", async () => {
    const driver = createLocalFileStorage({
      root: mkdtempSync(join(tmpdir(), "storage-review-ledger-missing-")),
    });
    const state = await readDeletionLedgerState(driver);
    expect(state.status).toBe("missing");
  });

  it("verifies the post-erasure state instead of the raw backup bytes", async () => {
    const subjectId = "user-erased-99";
    const dir = join(workDir, "export-erased");
    mkdirSync(dir, { recursive: true });
    const seed = mkdtempSync(join(tmpdir(), "storage-review-seed-"));
    try {
      writeFileSync(
        join(seed, "timekeeper-history.json"),
        JSON.stringify({ [subjectId]: ["2026-11-01"], "user-2": ["2026-11-01"] }),
        "utf8",
      );
      await exportStorage({ outDir: dir, source: createLocalFileStorage({ root: seed }) });
    } finally {
      rmSync(seed, { recursive: true, force: true });
    }

    // The live store knows the subject was deleted.
    const live = createLocalFileStorage({
      root: mkdtempSync(join(tmpdir(), "storage-review-live-")),
    });
    await appendDeletionRecord(live, {
      at: "2026-11-02T00:00:00.000Z",
      complete: true,
      digest: digestSubjectId(subjectId, LEDGER_KEY),
    });

    // Restoring re-applies the erasure …
    await importStorage({ allowOverwrite: true, dir, target: live });
    expect(await live.readText("timekeeper-history.json")).not.toContain(subjectId);

    // … and the verification recognises that state as correct instead of
    // reporting a checksum mismatch.
    const verification = await verifyStorage({ dir, target: live });
    expect(verification.mismatched).toEqual([]);
    expect(verification.missing).toEqual([]);
    expect(verification.erasureAdjusted).toContain("timekeeper-history.json");
  });
});
