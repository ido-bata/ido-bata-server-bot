import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeAnonIndex } from "../src/features/anonymous-chat/audit-crypto.js";
import {
  createAnonAuditSink,
  deleteAnonAuditRecords,
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
    indexKey: "test-index-key-0123456789",
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
      postedAt: "t",
    });
    await sink.record({
      userId: "u1",
      guildId: "g1",
      channelId: "c1",
      messageId: "m1",
      postedAt: "2026-11-13T00:00:00.000Z",
      ciphertext: ct,
    });

    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);

    const line = readFileSync(join(dir, files[0]!), "utf8").trim();
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(record.v).toBe(1);
    expect(record.gid).toBe("g1");
    expect(record.cid).toBe("c1");
    expect(record.mid).toBe("m1");
    expect(record.idx).toBe(computeAnonIndex("test-index-key-0123456789", "u1"));
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
    sink.seal({ userId: "u", guildId: "g", channelId: "c", postedAt: "t" });
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
});

describe("deleteAnonAuditRecords", () => {
  async function seedRecords(): Promise<void> {
    const sink = createAnonAuditSink(auditConfig());
    for (const userId of ["u1", "u2", "u1"]) {
      await sink.record({
        userId,
        guildId: "g",
        channelId: "c",
        messageId: `m-${userId}`,
        postedAt: "t",
        ciphertext: "ct",
      });
    }
  }

  it("removes only the target user's records", async () => {
    await seedRecords();
    const result = await deleteAnonAuditRecords({
      dir,
      indexKey: "test-index-key-0123456789",
      userId: "u1",
    });
    expect(result).toEqual({ ok: true, removed: 2 });

    const remaining = readFileSync(join(dir, dayFileName(new Date())), "utf8");
    const idx2 = computeAnonIndex("test-index-key-0123456789", "u2");
    expect(remaining).toContain(idx2);
    expect(remaining).not.toContain(computeAnonIndex("test-index-key-0123456789", "u1"));
  });

  it("returns ok with zero removals when the directory does not exist", async () => {
    const result = await deleteAnonAuditRecords({
      dir: join(dir, "missing"),
      indexKey: "k",
      userId: "u1",
    });
    expect(result).toEqual({ ok: true, removed: 0 });
  });

  it("fails closed when files exist but the index key is missing", async () => {
    await seedRecords();
    const result = await deleteAnonAuditRecords({
      dir,
      indexKey: undefined,
      userId: "u1",
    });
    expect(result.ok).toBe(false);
  });

  it("keeps corrupt lines instead of silently dropping them", async () => {
    mkdirSync(dir, { recursive: true });
    const name = dayFileName(new Date());
    writeFileSync(
      join(dir, name),
      `${JSON.stringify({ v: 1, idx: computeAnonIndex("test-index-key-0123456789", "u1") })}\nnot-json\n`,
    );
    const result = await deleteAnonAuditRecords({
      dir,
      indexKey: "test-index-key-0123456789",
      userId: "u1",
    });
    expect(result.ok).toBe(true);
    const remaining = readFileSync(join(dir, name), "utf8");
    expect(remaining).toContain("not-json");
    expect(remaining).not.toContain('"idx"');
  });
});
