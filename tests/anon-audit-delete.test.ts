import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteAnonAuditUserRecords } from "../src/features/anonymous-chat/audit-delete.js";
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
  dir = mkdtempSync(join(tmpdir(), "anon-audit-del-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
});

afterEach(() => cleanup());

function auditConfig(): AnonAuditConfig {
  return { publicKey, dir, retentionDays: 90 };
}

async function seed(userIds: string[]): Promise<void> {
  const sink = createAnonAuditSink(auditConfig());
  for (const userId of userIds) {
    await sink.record({
      userId,
      guildId: "g",
      channelId: "c",
      postedAt: "t",
      ciphertext: sink.seal({
        userId,
        guildId: "g",
        channelId: "c",
        postedAt: "t",
      }),
    });
  }
}

function dailyFiles(): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
}

describe("deleteAnonAuditUserRecords (offline custodian)", () => {
  it("removes only the target user's records", async () => {
    await seed(["u1", "u2", "u1"]);
    const result = await deleteAnonAuditUserRecords({
      dir,
      privateKey,
      userId: "u1",
    });
    expect(result).toEqual({ ok: true, scanned: 3, removed: 2 });

    const file = join(dir, dailyFiles()[0]!);
    const remaining = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    // Records carry no plaintext discriminator — assert by count.
    expect(remaining).toHaveLength(1);
  });

  it("deletes the whole file when every record belongs to the user", async () => {
    await seed(["u1", "u1"]);
    const result = await deleteAnonAuditUserRecords({
      dir,
      privateKey,
      userId: "u1",
    });
    expect(result).toMatchObject({ ok: true, removed: 2 });
    expect(dailyFiles()).toHaveLength(0);
  });

  it("succeeds with zero removals when nothing matches", async () => {
    await seed(["u2"]);
    const result = await deleteAnonAuditUserRecords({
      dir,
      privateKey,
      userId: "u1",
    });
    expect(result).toMatchObject({ ok: true, scanned: 1, removed: 0 });
    expect(dailyFiles()).toHaveLength(1);
  });

  it("fails closed on a corrupt line and modifies nothing", async () => {
    await seed(["u1"]);
    const file = join(dir, dailyFiles()[0]!);
    writeFileSync(file, `${readFileSync(file, "utf8")}not-json\n`);

    const result = await deleteAnonAuditUserRecords({
      dir,
      privateKey,
      userId: "u1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("corrupt");
    }
    // The file must be untouched — the user's record is still there.
    expect(readFileSync(file, "utf8")).toContain("not-json");
    expect(readFileSync(file, "utf8")).toContain('"v":1');
  });

  it("fails closed on an undecryptable record and modifies nothing", async () => {
    const { publicKey: otherPub } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { format: "pem", type: "spki" },
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
    });
    void otherPub;
    // Write a record sealed under a DIFFERENT key — undecryptable here.
    const foreign = createAnonAuditSink({
      publicKey: otherPub,
      dir,
      retentionDays: 90,
    });
    await foreign.record({
      userId: "uX",
      guildId: "g",
      channelId: "c",
      postedAt: "t",
      ciphertext: foreign.seal({
        userId: "uX",
        guildId: "g",
        channelId: "c",
        postedAt: "t",
      }),
    });

    const result = await deleteAnonAuditUserRecords({
      dir,
      privateKey,
      userId: "u1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("undecryptable");
    }
    expect(dailyFiles()).toHaveLength(1);
  });
});
