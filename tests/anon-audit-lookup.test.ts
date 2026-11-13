import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AnonAuditAttemptPlaintext,
  AnonAuditPostedPlaintext,
} from "../src/features/anonymous-chat/audit-crypto.js";
import { lookupAnonAuditRecords } from "../src/features/anonymous-chat/audit-lookup.js";
import { createAnonAuditSink } from "../src/features/anonymous-chat/audit-store.js";
import type { AnonAuditConfig } from "../src/features/anonymous-chat/config.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { format: "pem", type: "spki" },
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
});

let dir: string;
let cleanup: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anon-audit-lookup-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
});

afterEach(() => cleanup());

function auditConfig(): AnonAuditConfig {
  return { publicKey, keyId: "v1", dir, retentionDays: 90 };
}

async function seedPost(userId: string, messageId: string, attemptId = "a".repeat(32)) {
  const sink = createAnonAuditSink(auditConfig());
  await sink.record({
    kind: "attempt",
    guildId: "g",
    channelId: "c",
    ciphertext: sink.seal({
      v: 2,
      kind: "attempt",
      attemptId,
      userId,
      guildId: "g",
      channelId: "c",
      postedAt: "t",
    }),
  });
  await sink.record({
    kind: "posted",
    guildId: "g",
    channelId: "c",
    ciphertext: sink.seal({
      v: 2,
      kind: "posted",
      attemptId,
      messageId,
      userId,
      guildId: "g",
      channelId: "c",
      postedAt: "t2",
    }),
  });
}

describe("lookupAnonAuditRecords", () => {
  it("maps a real messageId to its author", async () => {
    await seedPost("user-1", "msg-123");
    const result = await lookupAnonAuditRecords({
      dir,
      privateKeys: [privateKey],
      filter: { messageId: "msg-123" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]?.plaintext).toMatchObject({
      kind: "posted",
      messageId: "msg-123",
      userId: "user-1",
    });
  });

  it("filters by userId across both record kinds", async () => {
    await seedPost("user-1", "msg-1");
    const result = await lookupAnonAuditRecords({
      dir,
      privateKeys: [privateKey],
      filter: { userId: "user-1" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matched).toHaveLength(2);
    expect(result.matched.map((m) => m.plaintext.kind).sort()).toEqual(["attempt", "posted"]);
  });

  it("filters by attemptId", async () => {
    await seedPost("user-1", "msg-1", "b".repeat(32));
    const result = await lookupAnonAuditRecords({
      dir,
      privateKeys: [privateKey],
      filter: { attemptId: "b".repeat(32) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matched).toHaveLength(2);
  });

  it("reports attempt records lacking a posted link", async () => {
    await seedPost("user-1", "msg-1");
    // Orphan attempt: send failed or crash before posted record.
    const sink = createAnonAuditSink(auditConfig());
    await sink.record({
      kind: "attempt",
      guildId: "g",
      channelId: "c",
      ciphertext: sink.seal({
        v: 2,
        kind: "attempt",
        attemptId: "c".repeat(32),
        userId: "user-2",
        guildId: "g",
        channelId: "c",
        postedAt: "t3",
      }),
    });
    const result = await lookupAnonAuditRecords({
      dir,
      privateKeys: [privateKey],
      filter: { unmatchedAttempts: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A pure anomaly scan must not dump the whole decrypted history.
    expect(result.matched).toHaveLength(0);
    expect(result.unmatchedAttempts).toHaveLength(1);
    expect(result.unmatchedAttempts[0]).toMatchObject({
      kind: "attempt",
      userId: "user-2",
      attemptId: "c".repeat(32),
    });
  });

  it("fails closed on a posted record missing messageId", async () => {
    const sink = createAnonAuditSink(auditConfig());
    await sink.record({
      kind: "posted",
      guildId: "g",
      channelId: "c",
      ciphertext: sink.seal({
        v: 2,
        kind: "posted",
        attemptId: "f".repeat(32),
        userId: "user-bad",
        guildId: "g",
        channelId: "c",
        postedAt: "t",
      } as unknown as AnonAuditPostedPlaintext),
    });
    const result = await lookupAnonAuditRecords({
      dir,
      privateKeys: [privateKey],
      filter: { userId: "user-bad" },
    });
    expect(result.ok).toBe(false);
  });

  it("fails closed on an unsupported record version", async () => {
    const sink = createAnonAuditSink(auditConfig());
    await sink.record({
      kind: "attempt",
      guildId: "g",
      channelId: "c",
      ciphertext: sink.seal({
        v: 3,
        kind: "attempt",
        attemptId: "0".repeat(32),
        userId: "user-v3",
        guildId: "g",
        channelId: "c",
        postedAt: "t",
      } as unknown as AnonAuditAttemptPlaintext),
    });
    const result = await lookupAnonAuditRecords({
      dir,
      privateKeys: [privateKey],
      filter: { userId: "user-v3" },
    });
    expect(result.ok).toBe(false);
  });

  it("still resolves legacy v1 records without v2 markers", async () => {
    const sink = createAnonAuditSink(auditConfig());
    await sink.record({
      kind: "attempt",
      guildId: "g",
      channelId: "c",
      ciphertext: sink.seal({
        userId: "user-legacy",
        guildId: "g",
        channelId: "c",
        postedAt: "t",
      } as unknown as AnonAuditAttemptPlaintext),
    });
    const result = await lookupAnonAuditRecords({
      dir,
      privateKeys: [privateKey],
      filter: { userId: "user-legacy" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]?.plaintext.userId).toBe("user-legacy");
  });

  it("tries multiple keys for rotation overlap", async () => {
    const other = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { format: "pem", type: "spki" },
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
    });
    // Record sealed under `other`'s public key.
    const foreignSink = createAnonAuditSink({ ...auditConfig(), publicKey: other.publicKey });
    await foreignSink.record({
      kind: "posted",
      guildId: "g",
      channelId: "c",
      ciphertext: foreignSink.seal({
        v: 2,
        kind: "posted",
        attemptId: "d".repeat(32),
        messageId: "msg-old",
        userId: "user-old",
        guildId: "g",
        channelId: "c",
        postedAt: "t",
      }),
    });
    const result = await lookupAnonAuditRecords({
      dir,
      privateKeys: [privateKey, other.privateKey],
      filter: { messageId: "msg-old" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matched[0]?.plaintext.userId).toBe("user-old");
  });

  it("fails closed on an undecryptable record", async () => {
    const other = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { format: "pem", type: "spki" },
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
    });
    const foreignSink = createAnonAuditSink({ ...auditConfig(), publicKey: other.publicKey });
    await foreignSink.record({
      kind: "attempt",
      guildId: "g",
      channelId: "c",
      ciphertext: foreignSink.seal({
        v: 2,
        kind: "attempt",
        attemptId: "e".repeat(32),
        userId: "user-x",
        guildId: "g",
        channelId: "c",
        postedAt: "t",
      }),
    });
    const result = await lookupAnonAuditRecords({
      dir,
      privateKeys: [privateKey],
      filter: { userId: "user-x" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("undecryptable");
  });

  it("fails closed on a corrupt record file", async () => {
    await seedPost("user-1", "msg-1");
    const file = join(dir, readdirSync(dir).find((n) => n.endsWith(".jsonl"))!);
    writeFileSync(file, "not-json\n");
    const result = await lookupAnonAuditRecords({
      dir,
      privateKeys: [privateKey],
      filter: { userId: "user-1" },
    });
    expect(result.ok).toBe(false);
  });

  it("returns empty results for a missing directory", async () => {
    const result = await lookupAnonAuditRecords({
      dir: join(dir, "missing"),
      privateKeys: [privateKey],
      filter: { userId: "user-1" },
    });
    expect(result).toEqual({ ok: true, scanned: 0, matched: [], unmatchedAttempts: [] });
  });
});
