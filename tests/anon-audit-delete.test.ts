import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
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

function recordFiles(): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
}

describe("deleteAnonAuditUserRecords (offline custodian)", () => {
  it("removes only the target user's record files", async () => {
    await seed(["u1", "u2", "u1"]);
    expect(recordFiles()).toHaveLength(3);
    const result = await deleteAnonAuditUserRecords({
      dir,
      privateKey,
      userId: "u1",
    });
    expect(result).toEqual({ ok: true, scanned: 3, removed: 2 });
    expect(recordFiles()).toHaveLength(1);
  });

  it("removes every file when all records belong to the user", async () => {
    await seed(["u1", "u1"]);
    const result = await deleteAnonAuditUserRecords({
      dir,
      privateKey,
      userId: "u1",
    });
    expect(result).toMatchObject({ ok: true, removed: 2 });
    expect(recordFiles()).toHaveLength(0);
  });

  it("succeeds with zero removals when nothing matches", async () => {
    await seed(["u2"]);
    const result = await deleteAnonAuditUserRecords({
      dir,
      privateKey,
      userId: "u1",
    });
    expect(result).toMatchObject({ ok: true, scanned: 1, removed: 0 });
    expect(recordFiles()).toHaveLength(1);
  });

  it("fails closed on a corrupt file and modifies nothing", async () => {
    await seed(["u1"]);
    const file = join(dir, recordFiles()[0]!);
    writeFileSync(file, "not-json\n");

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
    expect(readFileSync(file, "utf8")).toBe("not-json\n");
  });

  it("fails closed when a record decrypts to a malformed mapping", async () => {
    await seed(["u1"]);
    // A valid ciphertext whose plaintext lacks the sealed schema must
    // not be treated as "another user's record" — it might be the
    // target's, so the whole run aborts before any removal.
    const sink = createAnonAuditSink(auditConfig());
    const malformed = JSON.stringify({
      v: 1,
      gid: "g",
      cid: "c",
      ct: sink.seal({} as Parameters<typeof sink.seal>[0]),
    });
    writeFileSync(join(dir, "2026-11-13T12-00-00-000Z-deadbeef.jsonl"), `${malformed}\n`);

    const result = await deleteAnonAuditUserRecords({
      dir,
      privateKey,
      userId: "u1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("undecryptable or malformed");
    }
    // Nothing was modified — the u1 record file is still present.
    expect(recordFiles()).toHaveLength(2);
  });

  it("fails closed on an empty record file and modifies nothing", async () => {
    await seed(["u1", "u2"]);
    // An empty file may be an interrupted write hiding the target —
    // it must block ALL removals, not pass inspection silently.
    writeFileSync(join(dir, "2026-11-13T99-99-99-999Z-empty.jsonl"), "");

    const result = await deleteAnonAuditUserRecords({
      dir,
      privateKey,
      userId: "u1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("empty");
    }
    expect(recordFiles()).toHaveLength(3);
  });

  it("rewrites a legacy daily file keeping other users' records", async () => {
    // Legacy format: YYYY-MM-DD.jsonl, one record per line.
    const sink = createAnonAuditSink(auditConfig());
    const lines: string[] = [];
    for (const userId of ["u1", "u2"]) {
      lines.push(
        JSON.stringify({
          v: 1,
          gid: "g",
          cid: "c",
          mid: "m",
          ct: sink.seal({ userId, guildId: "g", channelId: "c", postedAt: "t" }),
        }),
      );
    }
    writeFileSync(join(dir, "2026-11-01.jsonl"), `${lines.join("\n")}\n`);

    const result = await deleteAnonAuditUserRecords({
      dir,
      privateKey,
      userId: "u1",
    });
    expect(result).toMatchObject({ ok: true, scanned: 2, removed: 1 });
    const remaining = readFileSync(join(dir, "2026-11-01.jsonl"), "utf8");
    expect(remaining.trim().split("\n")).toHaveLength(1);
    // The kept record still decrypts to u2.
    const kept = JSON.parse(remaining.trim()) as { ct: string };
    const opened = privateDecrypt(
      { key: privateKey, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING },
      Buffer.from(kept.ct, "base64"),
    ).toString("utf8");
    expect(JSON.parse(opened)).toMatchObject({ userId: "u2" });
  });

  it("removes a legacy daily file entirely when all records match", async () => {
    const sink = createAnonAuditSink(auditConfig());
    const line = JSON.stringify({
      v: 1,
      gid: "g",
      cid: "c",
      ct: sink.seal({ userId: "u1", guildId: "g", channelId: "c", postedAt: "t" }),
    });
    writeFileSync(join(dir, "2026-11-01.jsonl"), `${line}\n${line}\n`);

    const result = await deleteAnonAuditUserRecords({
      dir,
      privateKey,
      userId: "u1",
    });
    expect(result).toMatchObject({ ok: true, scanned: 2, removed: 2 });
    expect(recordFiles()).toHaveLength(0);
  });

  it("fails closed on a multi-record file rather than dropping others", async () => {
    await seed(["u1"]);
    const file = join(dir, recordFiles()[0]!);
    // A CURRENT-format file must hold exactly one record — a second
    // line means the layout is unexpected, so the run must abort
    // rather than risk a partial rewrite.
    writeFileSync(file, `${readFileSync(file, "utf8")}{"v":1,"ct":"x"}\n`);

    const result = await deleteAnonAuditUserRecords({
      dir,
      privateKey,
      userId: "u1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("multi-record");
    }
    expect(recordFiles()).toHaveLength(1);
  });

  it("fails closed on an undecryptable record and modifies nothing", async () => {
    const { publicKey: otherPub } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { format: "pem", type: "spki" },
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
    });
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
    expect(recordFiles()).toHaveLength(1);
  });
});
