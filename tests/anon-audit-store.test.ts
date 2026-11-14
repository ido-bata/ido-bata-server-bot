import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createAnonAuditSink,
  hasAnonAuditRecords,
} from "../src/features/anonymous-chat/audit-store.js";
import type { AnonAuditConfig } from "../src/features/anonymous-chat/config.js";
import { createLocalFileStorage } from "../src/lib/storage/local.js";
import type { StorageDriver } from "../src/lib/storage/types.js";

const { publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { format: "pem", type: "spki" },
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
});

let dir: string;
let cleanup: () => void;
let driver: StorageDriver;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anon-audit-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  driver = createLocalFileStorage({ root: dir });
});

afterEach(() => cleanup());

function auditConfig(overrides: Partial<AnonAuditConfig> = {}): AnonAuditConfig {
  return {
    publicKey,
    keyId: "v1",
    dir: "",
    retentionDays: 90,
    ...overrides,
  };
}

function attemptPlaintext() {
  return {
    v: 2 as const,
    kind: "attempt" as const,
    attemptId: "a".repeat(32),
    userId: "u1",
    guildId: "g1",
    channelId: "c1",
    postedAt: "2026-11-13T00:00:00.000Z",
  };
}

function recordInput(ciphertext: string, kind: "attempt" | "posted" = "attempt") {
  return { kind, guildId: "g1", channelId: "c1", ciphertext };
}

function recordFiles(): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
}

function oldRecordName(date: string): string {
  return `${date}T00-00-00-000Z-deadbeef.jsonl`;
}

describe("createAnonAuditSink", () => {
  it("writes one immutable file per record", async () => {
    const sink = createAnonAuditSink(auditConfig(), { driver });
    const ct = sink.seal(attemptPlaintext());
    await sink.record(recordInput(ct));

    const files = recordFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.*-[0-9a-f]+\.jsonl$/);

    const line = readFileSync(join(dir, files[0]!), "utf8").trim();
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(record.v).toBe(2);
    expect(record.kid).toBe("v1");
    expect(record.kind).toBe("attempt");
    expect(record.gid).toBe("g1");
    expect(record.cid).toBe("c1");
    // No plaintext message id or attempt id: Discord assigns the
    // messageId only after send and both stay inside the ciphertext
    // (ADR-0003 §3) — the bot host must not build a re-identification
    // index from stored data.
    expect(record).not.toHaveProperty("mid");
    expect(record).not.toHaveProperty("messageId");
    expect(record).not.toHaveProperty("attemptId");
    // No searchable per-user index may exist — it would be
    // dictionary-attackable over the public guild roster (ADR-0003 §3).
    expect(record).not.toHaveProperty("idx");
    expect(record).not.toHaveProperty("uidx");
    // The stored line must not contain the raw user id, attempt id,
    // message id, or plaintext body.
    expect(line).not.toContain('"u1"');
    expect(line).not.toContain("a".repeat(32));
    expect(typeof record.ct).toBe("string");
  });

  it("writes the configured key id into the envelope for rotation", async () => {
    const sink = createAnonAuditSink(auditConfig({ keyId: "v2-next" }), { driver });
    await sink.record(recordInput("ct", "posted"));
    const line = readFileSync(join(dir, recordFiles()[0]!), "utf8").trim();
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(record.kid).toBe("v2-next");
    expect(record.kind).toBe("posted");
  });

  it("publishes the first record into a prefix that did not exist yet", async () => {
    const sink = createAnonAuditSink(auditConfig({ dir: "anon-audit" }), { driver });
    await sink.record(recordInput("ct"));
    expect(
      readdirSync(join(dir, "anon-audit")).filter((name) => name.endsWith(".jsonl")),
    ).toHaveLength(1);
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

    const sink = createAnonAuditSink(auditConfig({ retentionDays: 30 }), { driver });
    await sink.record(recordInput("ct"));

    const remaining = recordFiles();
    expect(remaining).not.toContain(oldName);
    expect(remaining).not.toContain(legacyName);
    expect(remaining).toContain(recentLegacy);
    expect(remaining).toHaveLength(2); // legacy-today + new record
  });

  it("leaves no temp files behind after a successful record", async () => {
    const sink = createAnonAuditSink(auditConfig(), { driver });
    await sink.record(recordInput("ct"));
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
  });

  it("sweeps stale orphan temp files but keeps fresh ones", async () => {
    const sink = createAnonAuditSink(auditConfig(), { driver });
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
    const sink = createAnonAuditSink(auditConfig(), { driver });
    await Promise.all(Array.from({ length: 20 }, (_, i) => sink.record(recordInput(`ct-${i}`))));
    expect(recordFiles()).toHaveLength(20);
  });
});

describe("hasAnonAuditRecords", () => {
  it("returns false for a missing directory", async () => {
    expect(await hasAnonAuditRecords("missing", { driver })).toBe(false);
  });

  it("returns false for an empty directory", async () => {
    expect(await hasAnonAuditRecords("", { driver })).toBe(false);
  });

  it("returns true when a non-empty record file exists", async () => {
    const sink = createAnonAuditSink(auditConfig(), { driver });
    await sink.record(recordInput("ct"));
    expect(await hasAnonAuditRecords("", { driver })).toBe(true);
  });

  it("ignores non-record files and empty record files", async () => {
    writeFileSync(join(dir, "notes.txt"), "hello");
    writeFileSync(join(dir, "2026-11-13T00-00-00-000Z-empty.jsonl"), "");
    expect(await hasAnonAuditRecords("", { driver })).toBe(false);
  });

  it("detects legacy daily files", async () => {
    writeFileSync(join(dir, "2026-11-13.jsonl"), '{"v":1,"ct":"x"}\n');
    expect(await hasAnonAuditRecords("", { driver })).toBe(true);
  });

  it("publishes records with mode 0600", async () => {
    const sink = createAnonAuditSink(auditConfig(), { driver });
    await sink.record(recordInput("ct"));
    const file = join(dir, recordFiles()[0]!);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("fails closed on an unwritable audit dir — no partial record is published", async () => {
    const sink = createAnonAuditSink(auditConfig(), { driver });
    chmodSync(dir, 0o500);
    try {
      await expect(sink.record(recordInput("ct"))).rejects.toThrow();
      // No final record AND no leftover temp may exist.
      expect(recordFiles()).toHaveLength(0);
      expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("treats temp files as possible records (fail closed)", async () => {
    writeFileSync(join(dir, ".2026-11-13T00-00-00-000Z-aaaabbbb.tmp"), "partial");
    expect(await hasAnonAuditRecords("", { driver })).toBe(true);
  });
});
