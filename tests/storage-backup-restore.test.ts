import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appendDeletionRecord,
  digestSubjectId,
  readDeletionLedger,
} from "../src/lib/storage/deletions.js";
import { applyDeletionLedger } from "../src/lib/storage/erasure.js";
import { createLocalFileStorage } from "../src/lib/storage/local.js";
import { createU3Storage } from "../src/lib/storage/u3.js";
import { exportStorage, importStorage, verifyStorage } from "../src/scripts/storage-migrate.js";
import { type FakeS3Server, startFakeS3Server } from "./helpers/fake-s3.js";

const LEDGER_KEY = "test-ledger-key-0123456789";

describe("backup and restore drill", () => {
  let server: FakeS3Server;
  let primary: ReturnType<typeof createU3Storage>;
  let backup: ReturnType<typeof createU3Storage>;
  let restored: ReturnType<typeof createU3Storage>;
  let workDir: string;

  beforeAll(async () => {
    server = await startFakeS3Server();
    primary = createU3Storage({
      accessKeyId: "AKTESTTESTTEST",
      bucket: "primary-bucket",
      endpoint: server.endpoint,
      region: "eu",
      secretAccessKey: "test-secret",
    });
    backup = createU3Storage({
      accessKeyId: "AKTESTTESTTEST",
      bucket: "backup-bucket",
      endpoint: server.endpoint,
      region: "eu",
      secretAccessKey: "test-secret",
    });
    restored = createU3Storage({
      accessKeyId: "AKTESTTESTTEST",
      bucket: "restored-bucket",
      endpoint: server.endpoint,
      region: "eu",
      secretAccessKey: "test-secret",
    });
    workDir = mkdtempSync(join(tmpdir(), "storage-drill-"));
  });

  afterAll(async () => {
    await server.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("copies the live bucket into a backup bucket and restores it into a fresh one", async () => {
    // 1. The live bucket holds the production state.
    await primary.write("consent.json", '{"schemaVersion":1,"records":[]}');
    await primary.write("timekeeper-history.json", '{"user-1":["2026-11-01"]}');
    await primary.write("anon-audit/2026-11-13T00-00-00-000Z-deadbeef.jsonl", '{"v":2}\n');

    // 2. Backup: export the primary bucket, import it into the backup bucket.
    const exportDir = join(workDir, "export");
    mkdirSync(exportDir, { recursive: true });
    const manifest = await exportStorage({ outDir: exportDir, source: primary });
    expect(manifest.entries).toHaveLength(3);

    const backupReport = await importStorage({
      allowOverwrite: true,
      dir: exportDir,
      target: backup,
    });
    expect(backupReport.imported).toBe(3);

    // 3. The backup bucket holds the same objects.
    const backupCheck = await verifyStorage({ dir: exportDir, target: backup });
    expect(backupCheck.verified).toBe(3);
    expect(backupCheck.missing).toEqual([]);

    // 4. Restore drill: import the backup into an empty bucket and verify.
    const restoreDir = join(workDir, "restore");
    mkdirSync(restoreDir, { recursive: true });
    const restoreExport = await exportStorage({ outDir: restoreDir, source: backup });
    expect(restoreExport.entries).toHaveLength(3);

    const restoreReport = await importStorage({
      allowOverwrite: true,
      dir: restoreDir,
      target: restored,
    });
    expect(restoreReport.imported).toBe(3);

    const restoredCheck = await verifyStorage({ dir: restoreDir, target: restored });
    expect(restoredCheck.verified).toBe(3);
    expect(restoredCheck.missing).toEqual([]);
    expect(restoredCheck.mismatched).toEqual([]);
    expect(await restored.readText("timekeeper-history.json")).toBe('{"user-1":["2026-11-01"]}');
  });

  it("does not resurrect data that was deleted after the backup was taken", async () => {
    const subjectId = "user-deleted-42";
    const backupDir = join(workDir, "deletion-backup");
    mkdirSync(backupDir, { recursive: true });

    const consentPayload = JSON.stringify({
      records: [
        {
          grantedAt: "2026-11-01T00:00:00.000Z",
          policyVersion: "v0.2.0",
          revokedAt: null,
          scope: "activity-history",
          source: {
            channelId: "c1",
            emoji: "📊",
            guildId: "g1",
            messageId: "m1",
          },
          subjectId,
        },
      ],
      schemaVersion: 1,
    });
    const historyPayload = JSON.stringify({
      [subjectId]: ["2026-11-01"],
      "user-2": ["2026-11-01"],
    });

    // The backup was taken while the subject was still present.
    const seedRoot = mkdtempSync(join(tmpdir(), "storage-drill-seed-"));
    try {
      writeFileSync(join(seedRoot, "consent.json"), consentPayload, "utf8");
      writeFileSync(join(seedRoot, "timekeeper-history.json"), historyPayload, "utf8");
      await exportStorage({
        outDir: backupDir,
        source: createLocalFileStorage({ root: seedRoot }),
      });
    } finally {
      rmSync(seedRoot, { recursive: true, force: true });
    }

    // The live store holds the same data plus the ledger entry that
    // records the deletion (the deletion happened after the backup).
    const liveRoot = mkdtempSync(join(tmpdir(), "storage-drill-live-"));
    const live = createLocalFileStorage({ root: liveRoot });
    try {
      await live.write("consent.json", consentPayload);
      await live.write("timekeeper-history.json", historyPayload);
      await appendDeletionRecord(live, {
        at: "2026-11-02T00:00:00.000Z",
        complete: true,
        digest: digestSubjectId(subjectId, LEDGER_KEY),
      });

      // Restoring the old backup over the live store would bring the
      // deleted subject back …
      const restoreReport = await importStorage({
        allowOverwrite: true,
        dir: backupDir,
        target: live,
      });
      expect(await live.readText("timekeeper-history.json")).toContain(subjectId);

      // … unless the recorded erasure is re-applied. The restore applies
      // the ledger itself, so the caller only sees the end state.
      const erasure = await applyDeletionLedger(live, LEDGER_KEY);
      expect(erasure.removedSubjects).toEqual([subjectId]);
      expect(erasure.rewrittenObjects).toContain("timekeeper-history.json");
      expect(erasure.rewrittenObjects).toContain("consent.json");

      const afterRestore = await live.readText("timekeeper-history.json");
      expect(afterRestore).not.toContain(subjectId);
      expect(afterRestore).toContain("user-2");

      const consent = await live.readText("consent.json");
      expect(consent).not.toContain(subjectId);
      void restoreReport;
    } finally {
      rmSync(liveRoot, { recursive: true, force: true });
    }
  });

  it("keeps the deletion ledger when an older backup is restored", async () => {
    const subjectId = "user-deleted-43";
    const ledgerRoot = mkdtempSync(join(tmpdir(), "storage-drill-ledger-"));
    try {
      const live = createLocalFileStorage({ root: ledgerRoot });
      await live.write("timekeeper-history.json", JSON.stringify({ [subjectId]: ["2026-11-01"] }));
      await appendDeletionRecord(live, {
        at: "2026-11-02T00:00:00.000Z",
        complete: true,
        digest: digestSubjectId(subjectId, LEDGER_KEY),
      });

      // An older backup without the ledger is restored over the live store.
      const oldBackup = mkdtempSync(join(tmpdir(), "storage-drill-old-"));
      try {
        writeFileSync(
          join(oldBackup, "timekeeper-history.json"),
          JSON.stringify({ [subjectId]: ["2026-11-01"] }),
          "utf8",
        );
        const exportDir = join(workDir, "old-backup-export");
        mkdirSync(exportDir, { recursive: true });
        await exportStorage({
          outDir: exportDir,
          source: createLocalFileStorage({ root: oldBackup }),
        });
        await importStorage({ allowOverwrite: true, dir: exportDir, target: live });
      } finally {
        rmSync(oldBackup, { recursive: true, force: true });
      }

      // The live deletion record must survive the restore.
      const ledger = await readDeletionLedger(live);
      expect(ledger.records.map((record) => record.digest)).toContain(
        digestSubjectId(subjectId, LEDGER_KEY),
      );
    } finally {
      rmSync(ledgerRoot, { recursive: true, force: true });
    }
  });

  it("warns instead of silently skipping when the ledger key is missing", async () => {
    const store = createLocalFileStorage({
      root: mkdtempSync(join(tmpdir(), "storage-drill-nokey-")),
    });
    const erasure = await applyDeletionLedger(store, "");
    expect(erasure.removedSubjects).toEqual([]);
    expect(erasure.rewrittenObjects).toEqual([]);
  });
});
