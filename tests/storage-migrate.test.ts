import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalFileStorage } from "../src/lib/storage/local.js";
import { createU3Storage } from "../src/lib/storage/u3.js";
import {
  exportStorage,
  importStorage,
  readManifest,
  verifyStorage,
} from "../src/scripts/storage-migrate.js";
import { type FakeS3Server, startFakeS3Server } from "./helpers/fake-s3.js";

describe("storage migration tooling", () => {
  let server: FakeS3Server;
  let sourceRoot: string;
  let exportDir: string;
  let target: ReturnType<typeof createU3Storage>;

  beforeAll(async () => {
    // The restore path refuses to run without the ledger key: the
    // recorded erasures could not be re-applied otherwise.
    process.env.DELETION_LEDGER_KEY = "migrate-test-ledger-key-0123456789";
    server = await startFakeS3Server();
    sourceRoot = mkdtempSync(join(tmpdir(), "storage-migrate-source-"));
    exportDir = mkdtempSync(join(tmpdir(), "storage-migrate-export-"));
    mkdirSync(join(sourceRoot, "anon-audit"), { recursive: true });
    writeFileSync(join(sourceRoot, "consent.json"), '{"records":[]}', "utf8");
    writeFileSync(join(sourceRoot, "timekeeper-history.json"), '{"user-1":["2026-11-01"]}', "utf8");
    writeFileSync(
      join(sourceRoot, "anon-audit", "2026-11-13T00-00-00-000Z-deadbeef.jsonl"),
      '{"v":2,"ct":"cipher"}\n',
      "utf8",
    );
    target = createU3Storage({
      accessKeyId: "AKTESTTESTTEST",
      bucket: server.bucket,
      endpoint: server.endpoint,
      region: "eu",
      secretAccessKey: "test-secret",
    });
  });

  afterAll(async () => {
    await server.close();
    delete process.env.DELETION_LEDGER_KEY;
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(exportDir, { recursive: true, force: true });
  });

  it("exports every object with a checksum manifest", async () => {
    const manifest = await exportStorage({
      outDir: exportDir,
      source: createLocalFileStorage({ root: sourceRoot }),
    });

    expect(manifest.entries.map((entry) => entry.key).sort()).toEqual([
      "anon-audit/2026-11-13T00-00-00-000Z-deadbeef.jsonl",
      "consent.json",
      "timekeeper-history.json",
    ]);
    for (const entry of manifest.entries) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.size).toBeGreaterThan(0);
    }
    const reread = await readManifest(exportDir);
    expect(reread.entries).toHaveLength(3);
  });

  it("imports the export into the object backend and verifies every object", async () => {
    const report = await importStorage({ allowOverwrite: true, dir: exportDir, target });
    expect(report.imported).toBe(3);
    expect(report.verified).toBe(3);
    expect(await target.readText("consent.json")).toBe('{"records":[]}');
  });

  it("verifies the backend against the export manifest", async () => {
    const report = await verifyStorage({ dir: exportDir, target });
    expect(report.verified).toBe(3);
    expect(report.missing).toEqual([]);
    expect(report.mismatched).toEqual([]);
    expect(report.extra).toEqual([]);
  });

  it("reports a missing object as a verification failure", async () => {
    await target.delete("consent.json");
    const report = await verifyStorage({ dir: exportDir, target });
    expect(report.missing).toEqual(["consent.json"]);
    expect(report.verified).toBe(2);
  });

  it("refuses to import a corrupted export", async () => {
    const dir = mkdtempSync(join(tmpdir(), "storage-migrate-corrupt-"));
    try {
      await exportStorage({
        outDir: dir,
        source: createLocalFileStorage({ root: sourceRoot }),
      });
      // Tamper with an exported object — the checksum must catch it.
      writeFileSync(join(dir, "consent.json"), '{"records":["tampered"]}', "utf8");
      await expect(importStorage({ allowOverwrite: true, dir, target })).rejects.toThrow(
        /checksum mismatch/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an existing object unless asked", async () => {
    await target.write("consent.json", '{"records":[]}');
    await expect(importStorage({ allowOverwrite: false, dir: exportDir, target })).rejects.toThrow(
      /already holds/,
    );
  });
});
