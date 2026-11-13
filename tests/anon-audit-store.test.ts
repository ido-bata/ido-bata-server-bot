import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createAnonAuditSink,
  hasAnonAuditRecords,
} from "../src/features/anonymous-chat/audit-store.js";
import type { AnonAuditConfig } from "../src/features/anonymous-chat/config.js";

const { publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { format: "pem", type: "spki" },
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
});

let dir: string;
let cleanup: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anon-audit-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
});

afterEach(() => cleanup());

function auditConfig(overrides: Partial<AnonAuditConfig> = {}): AnonAuditConfig {
  return {
    publicKey,
    dir,
    retentionDays: 90,
    ...overrides,
  };
}

function recordFiles(): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
}

function oldRecordName(date: string): string {
  return `${date}T00-00-00-000Z-deadbeef.jsonl`;
}

describe("createAnonAuditSink", () => {
  it("writes one immutable file per record", async () => {
    const sink = createAnonAuditSink(auditConfig());
    const ct = sink.seal({
      userId: "u1",
      guildId: "g1",
      channelId: "c1",
      postedAt: "2026-11-13T00:00:00.000Z",
    });
    await sink.record({
      userId: "u1",
      guildId: "g1",
      channelId: "c1",
      postedAt: "2026-11-13T00:00:00.000Z",
      ciphertext: ct,
    });

    const files = recordFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.*-[0-9a-f]+\.jsonl$/);

    const line = readFileSync(join(dir, files[0]!), "utf8").trim();
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(record.v).toBe(1);
    expect(record.gid).toBe("g1");
    expect(record.cid).toBe("c1");
    // No plaintext message id: Discord assigns it only after send and
    // the audit record must exist before the send (ADR-0003 §3).
    expect(record).not.toHaveProperty("mid");
    // No searchable per-user index may exist — it would be
    // dictionary-attackable over the public guild roster (ADR-0003 §3).
    expect(record).not.toHaveProperty("idx");
    expect(record).not.toHaveProperty("uidx");
    // The stored line must not contain the raw user id or plaintext body.
    expect(line).not.toContain('"u1"');
    expect(typeof record.ct).toBe("string");
  });

  it("creates a missing audit directory eagerly at sink construction", () => {
    const fresh = join(dir, "nested", "anon-audit");
    expect(() => createAnonAuditSink(auditConfig({ dir: fresh }))).not.toThrow();
    expect(readdirSync(fresh)).toHaveLength(0);
  });

  it("sweeps files older than the retention window before appending", async () => {
    const oldName = oldRecordName("2020-01-01");
    writeFileSync(join(dir, oldName), '{"v":1,"ct":"x"}\n');
    // Legacy daily format is swept by the same date-prefix rule.
    const legacyName = "2020-01-02.jsonl";
    writeFileSync(join(dir, legacyName), '{"v":1,"ct":"x"}\n');
    // A recent legacy file must survive.
    const recentLegacy = `${new Date().toISOString().slice(0, 10)}.jsonl`;
    writeFileSync(join(dir, recentLegacy), '{"v":1,"ct":"x"}\n');

    const sink = createAnonAuditSink(auditConfig({ retentionDays: 30 }));
    await sink.record({
      userId: "u1",
      guildId: "g",
      channelId: "c",
      postedAt: "t",
      ciphertext: "ct",
    });

    const remaining = recordFiles();
    expect(remaining).not.toContain(oldName);
    expect(remaining).not.toContain(legacyName);
    expect(remaining).toContain(recentLegacy);
    expect(remaining).toHaveLength(2); // legacy-today + new record
  });

  it("leaves no temp files behind after a successful record", async () => {
    const sink = createAnonAuditSink(auditConfig());
    await sink.record({
      userId: "u1",
      guildId: "g",
      channelId: "c",
      postedAt: "t",
      ciphertext: "ct",
    });
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
  });

  it("sweeps stale orphan temp files but keeps fresh ones", async () => {
    const sink = createAnonAuditSink(auditConfig());
    const stale = join(dir, ".2020-01-01T00-00-00-000Z-aaaa1111.tmp");
    writeFileSync(stale, "partial");
    // Backdate the temp file beyond TMP_STALE_MS (1h).
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    // A fresh in-flight temp must survive the sweep.
    writeFileSync(join(dir, ".2099-01-01T00-00-00-000Z-bbbb2222.tmp"), "in-flight");
    await sink.sweep();
    const temps = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    expect(temps).toEqual([".2099-01-01T00-00-00-000Z-bbbb2222.tmp"]);
  });

  it("serializes concurrent appends without losing records", async () => {
    const sink = createAnonAuditSink(auditConfig());
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        sink.record({
          userId: `u${i % 3}`,
          guildId: "g",
          channelId: "c",
          postedAt: "t",
          ciphertext: `ct-${i}`,
        }),
      ),
    );
    expect(recordFiles()).toHaveLength(20);
  });
});

describe("hasAnonAuditRecords", () => {
  it("returns false for a missing directory", async () => {
    expect(await hasAnonAuditRecords(join(dir, "missing"))).toBe(false);
  });

  it("returns false for an empty directory", async () => {
    expect(await hasAnonAuditRecords(dir)).toBe(false);
  });

  it("returns true when a non-empty record file exists", async () => {
    const sink = createAnonAuditSink(auditConfig());
    await sink.record({
      userId: "u1",
      guildId: "g",
      channelId: "c",
      postedAt: "t",
      ciphertext: "ct",
    });
    expect(await hasAnonAuditRecords(dir)).toBe(true);
  });

  it("ignores non-record files and empty record files", async () => {
    writeFileSync(join(dir, "notes.txt"), "hello");
    writeFileSync(join(dir, "2026-11-13T00-00-00-000Z-empty.jsonl"), "");
    expect(await hasAnonAuditRecords(dir)).toBe(false);
  });

  it("detects legacy daily files", async () => {
    writeFileSync(join(dir, "2026-11-13.jsonl"), '{"v":1,"ct":"x"}\n');
    expect(await hasAnonAuditRecords(dir)).toBe(true);
  });

  it("treats temp files as possible records (fail closed)", async () => {
    writeFileSync(join(dir, ".2026-11-13T00-00-00-000Z-aaaabbbb.tmp"), "partial");
    expect(await hasAnonAuditRecords(dir)).toBe(true);
  });
});
