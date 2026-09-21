import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { mutateJsonFile } from "../atomic-json.js";

const storeSchema = z.object({
  count: z.number().int(),
});

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "atomic-json-"));
}

describe("mutateJsonFile", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("returns ok:true with mutated:false when the file does not exist (ENOENT is success)", async () => {
    const filePath = join(workDir, "missing.json");
    const outcome = await mutateJsonFile({
      filePath,
      mutate: (current) => ({ count: current.count + 1 }),
      schema: storeSchema,
    });
    expect(outcome).toEqual({ ok: true, mutated: false });
  });

  it("parses + mutates + atomically writes a well-formed file", async () => {
    const filePath = join(workDir, "store.json");
    writeFileSync(filePath, JSON.stringify({ count: 7 }));

    const outcome = await mutateJsonFile({
      filePath,
      mutate: (current) => ({ count: current.count + 1 }),
      schema: storeSchema,
    });
    expect(outcome).toEqual({ ok: true, mutated: true });

    const written = JSON.parse(readFileSync(filePath, "utf8")) as { count: number };
    expect(written.count).toBe(8);
  });

  it("returns ok:false with a parse error when the file contains corrupted JSON", async () => {
    const filePath = join(workDir, "broken.json");
    writeFileSync(filePath, "{ count: 'not valid");

    const outcome = await mutateJsonFile({
      filePath,
      mutate: (current) => ({ count: current.count + 1 }),
      schema: storeSchema,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toMatch(/parse failed/);
    }
    // The original corrupted file is left intact so the operator can
    // inspect what went wrong. The helper does NOT overwrite it with
    // a default.
    const remaining = readFileSync(filePath, "utf8");
    expect(remaining).toBe("{ count: 'not valid");
  });

  it("returns ok:false with a schema-mismatch error when JSON parses but the shape is wrong", async () => {
    const filePath = join(workDir, "wrong-shape.json");
    writeFileSync(filePath, JSON.stringify({ wrong: "shape" }));

    const outcome = await mutateJsonFile({
      filePath,
      mutate: (current) => ({ count: current.count + 1 }),
      schema: storeSchema,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toMatch(/schema mismatch/);
    }
  });

  it("returns ok:false when the file is unreadable", async () => {
    const filePath = join(workDir, "locked.json");
    writeFileSync(filePath, JSON.stringify({ count: 0 }));
    // Strip read permission so readFileSync throws EACCES.
    chmodSync(filePath, 0o000);

    const outcome = await mutateJsonFile({
      filePath,
      mutate: (current) => ({ count: current.count + 1 }),
      schema: storeSchema,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toMatch(/read failed/);
    }
    // Restore permission so afterEach cleanup can rmSync.
    chmodSync(filePath, 0o600);
  });

  it("skips the write when mutate returns the same reference (no-change fast path)", async () => {
    const filePath = join(workDir, "unchanged.json");
    writeFileSync(filePath, JSON.stringify({ count: 42 }));
    const before = readFileSync(filePath, "utf8");

    const outcome = await mutateJsonFile({
      filePath,
      mutate: (current) => current,
      schema: storeSchema,
    });
    expect(outcome).toEqual({ ok: true, mutated: false });
    const after = readFileSync(filePath, "utf8");
    expect(after).toBe(before);
  });
});
