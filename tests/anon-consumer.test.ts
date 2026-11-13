import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deleteUserData } from "../src/features/privacy/consumers/anon-audit.js";

let dir: string;
let cleanup: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anon-consumer-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
});

afterEach(() => cleanup());

describe("anonymous-chat-audit privacy consumer", () => {
  it("reports ok when no audit records exist", async () => {
    const result = await deleteUserData("user-1", { dir: join(dir, "missing") });
    expect(result).toEqual({ ok: true });
  });

  it("reports ok for an empty audit directory", async () => {
    const result = await deleteUserData("user-1", { dir });
    expect(result).toEqual({ ok: true });
  });

  it("fails honestly when audit records exist — bot cannot selectively delete", async () => {
    writeFileSync(join(dir, "2026-11-13.jsonl"), '{"v":1,"ct":"x"}\n');
    const result = await deleteUserData("user-1", { dir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("offline");
      expect(result.error).not.toContain("user-1");
    }
  });
});
