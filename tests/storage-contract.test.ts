import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalFileStorage } from "../src/lib/storage/local.js";
import type { StorageDriver } from "../src/lib/storage/types.js";
import { createU3Storage } from "../src/lib/storage/u3.js";
import { type FakeS3Server, startFakeS3Server } from "./helpers/fake-s3.js";

/**
 * The storage contract is the guarantee the whole migration rests on:
 * every backend must behave identically, otherwise a feature would work
 * on the local host and break on Altare (or worse: fail open).
 */
function describeContract(name: string, createDriver: () => Promise<StorageDriver>): void {
  describe(`storage contract: ${name}`, () => {
    let driver: StorageDriver;

    beforeAll(async () => {
      driver = await createDriver();
    });

    it("returns null for a missing key", async () => {
      expect(await driver.read("missing.json")).toBeNull();
      expect(await driver.readText("missing.json")).toBeNull();
      expect(await driver.exists("missing.json")).toBe(false);
    });

    it("writes and reads back an object", async () => {
      await driver.write("greeting.json", '{"hello":"world"}');
      expect(await driver.readText("greeting.json")).toBe('{"hello":"world"}');
      expect(await driver.exists("greeting.json")).toBe(true);
    });

    it("replaces an existing object", async () => {
      await driver.write("counter.json", "1");
      await driver.write("counter.json", "2");
      expect(await driver.readText("counter.json")).toBe("2");
    });

    it("refuses to overwrite on an exclusive write", async () => {
      expect(await driver.writeExclusive("exclusive.json", "first")).toBe(true);
      expect(await driver.writeExclusive("exclusive.json", "second")).toBe(false);
      expect(await driver.readText("exclusive.json")).toBe("first");
    });

    it("lists objects under a prefix, sorted by key", async () => {
      await driver.write("prefix/b.json", "b");
      await driver.write("prefix/a.json", "a");
      await driver.write("other.json", "x");

      const entries = await driver.list("prefix/");
      expect(entries.map((entry) => entry.key)).toEqual(["prefix/a.json", "prefix/b.json"]);
      expect(entries.every((entry) => entry.size > 0)).toBe(true);
    });

    it("deletes an object and tolerates a missing one", async () => {
      await driver.write("doomed.json", "x");
      await driver.delete("doomed.json");
      expect(await driver.exists("doomed.json")).toBe(false);
      await expect(driver.delete("doomed.json")).resolves.toBeUndefined();
    });

    it("moves an object", async () => {
      await driver.write("from.json", "payload");
      await driver.move("from.json", "to.json");
      expect(await driver.exists("from.json")).toBe(false);
      expect(await driver.readText("to.json")).toBe("payload");
    });

    it("stores nested keys", async () => {
      await driver.write("anon-audit/2026-11-13T00-00-00-000Z-deadbeef.jsonl", "{}\n");
      const entries = await driver.list("anon-audit/");
      expect(entries.map((entry) => entry.key)).toEqual([
        "anon-audit/2026-11-13T00-00-00-000Z-deadbeef.jsonl",
      ]);
    });
  });
}

describeContract("local filesystem", async () => {
  const root = mkdtempSync(join(tmpdir(), "storage-contract-local-"));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return createLocalFileStorage({ root });
});

describeContract("u3 (s3-compatible)", async () => {
  const server: FakeS3Server = await startFakeS3Server();
  afterAll(async () => {
    await server.close();
  });
  return createU3Storage({
    accessKeyId: "AKTESTTESTTEST",
    bucket: server.bucket,
    endpoint: server.endpoint,
    region: "eu",
    secretAccessKey: "test-secret",
  });
});
