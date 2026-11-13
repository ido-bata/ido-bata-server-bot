import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function dayFileName(date: Date): string {
  return `${date.toISOString().slice(0, 10)}.jsonl`;
}

describe("createAnonAuditSink", () => {
  it("appends a sealed record to the daily JSONL file", async () => {
    const sink = createAnonAuditSink(auditConfig());
    const ct = sink.seal({
      userId: "u1",
      guildId: "g1",
      channelId: "c1",
      messageId: "m1",
      postedAt: "2026-11-13T00:00:00.000Z",
    });
    await sink.record({
      userId: "u1",
      guildId: "g1",
      channelId: "c1",
      messageId: "m1",
      postedAt: "2026-11-13T00:00:00.000Z",
      ciphertext: ct,
    });

    const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);

    const line = readFileSync(join(dir, files[0]!), "utf8").trim();
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(record.v).toBe(1);
    expect(record.gid).toBe("g1");
    expect(record.cid).toBe("c1");
    expect(record.mid).toBe("m1");
    // No searchable per-user index may exist — it would be
    // dictionary-attackable over the public guild roster (ADR-0003 §3).
    expect(record).not.toHaveProperty("idx");
    expect(record).not.toHaveProperty("uidx");
    // The stored line must not contain the raw user id or plaintext body.
    expect(line).not.toContain('"u1"');
    expect(typeof record.ct).toBe("string");
  });

  it("sweeps files older than the retention window before appending", async () => {
    mkdirSync(dir, { recursive: true });
    const oldName = "2020-01-01.jsonl";
    writeFileSync(join(dir, oldName), '{"v":1}\n');
    const recentName = dayFileName(new Date());
    writeFileSync(join(dir, recentName), '{"v":1}\n');

    const sink = createAnonAuditSink(auditConfig({ retentionDays: 30 }));
    await sink.record({
      userId: "u1",
      guildId: "g",
      channelId: "c",
      messageId: "m",
      postedAt: "t",
      ciphertext: "ct",
    });

    const remaining = readdirSync(dir);
    expect(remaining).not.toContain(oldName);
    expect(remaining).toContain(recentName);
  });

  it("serializes concurrent appends and sweeps without losing lines", async () => {
    const sink = createAnonAuditSink(auditConfig());
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        sink.record({
          userId: `u${i % 3}`,
          guildId: "g",
          channelId: "c",
          messageId: `m-${i}`,
          postedAt: "t",
          ciphertext: `ct-${i}`,
        }),
      ),
    );
    const file = join(dir, dayFileName(new Date()));
    const lines = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(lines).toHaveLength(20);
  });
});

describe("hasAnonAuditRecords", () => {
  it("returns false for a missing directory", async () => {
    expect(await hasAnonAuditRecords(join(dir, "missing"))).toBe(false);
  });

  it("returns false for an empty directory", async () => {
    expect(await hasAnonAuditRecords(dir)).toBe(false);
  });

  it("returns true when a non-empty daily file exists", async () => {
    const sink = createAnonAuditSink(auditConfig());
    await sink.record({
      userId: "u1",
      guildId: "g",
      channelId: "c",
      messageId: "m",
      postedAt: "t",
      ciphertext: "ct",
    });
    expect(await hasAnonAuditRecords(dir)).toBe(true);
  });

  it("ignores non-daily files and empty daily files", async () => {
    writeFileSync(join(dir, "notes.txt"), "hello");
    writeFileSync(join(dir, dayFileName(new Date())), "");
    expect(await hasAnonAuditRecords(dir)).toBe(false);
  });
});
