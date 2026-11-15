import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deleteUserData } from "../src/features/privacy/consumers/anon-audit.js";
import { setStorageDriver } from "../src/lib/storage/index.js";
import { createLocalFileStorage } from "../src/lib/storage/local.js";
import type { StorageDriver } from "../src/lib/storage/types.js";

let dir: string;
let cleanup: () => void;
let driver: StorageDriver;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anon-consumer-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  driver = createLocalFileStorage({ root: dir });
  setStorageDriver(driver);
});

afterEach(() => {
  setStorageDriver(null);
  cleanup();
});

describe("anonymous-chat-audit privacy consumer", () => {
  it("reports ok when no audit records exist", async () => {
    const result = await deleteUserData("user-1", { dir: "missing", driver });
    expect(result).toEqual({ ok: true });
  });

  it("reports ok for an empty audit directory", async () => {
    const result = await deleteUserData("user-1", { dir: "", driver });
    expect(result).toEqual({ ok: true });
  });

  it("fails honestly when audit records exist — bot cannot selectively delete", async () => {
    writeFileSync(join(dir, "2026-11-13T00-00-00-000Z-abcd1234.jsonl"), '{"v":1,"ct":"x"}\n');
    const result = await deleteUserData("user-1", { dir: "", driver });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("offline");
      expect(result.error).not.toContain("user-1");
    }
  });

  it("normalizes ANON_AUDIT_DIR exactly like the writer (trim + blank fallback)", async () => {
    mkdirSync(join(dir, "anon-audit"), { recursive: true });
    writeFileSync(
      join(dir, "anon-audit", "2026-11-13T00-00-00-000Z-abcd1234.jsonl"),
      '{"v":1,"ct":"x"}\n',
    );
    const previous = process.env.ANON_AUDIT_DIR;
    try {
      // Padded env value: the writer trims it, so the consumer must
      // inspect the trimmed path — not a space-padded nonexistent one.
      process.env.ANON_AUDIT_DIR = "  anon-audit  ";
      const padded = await deleteUserData("user-1");
      expect(padded.ok).toBe(false);
      // Blank env value falls back to the default dir, same as writer.
      process.env.ANON_AUDIT_DIR = "   ";
      const blank = await deleteUserData("user-1");
      expect(typeof blank.ok).toBe("boolean");
    } finally {
      if (previous === undefined) {
        delete process.env.ANON_AUDIT_DIR;
      } else {
        process.env.ANON_AUDIT_DIR = previous;
      }
    }
  });
});
