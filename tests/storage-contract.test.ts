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

    it("reports a version token for an object", async () => {
      await driver.write("versioned.json", "one");
      const first = await driver.readVersioned("versioned.json");
      expect(first?.data).toBeDefined();
      expect(first?.version).toBeTruthy();
      await driver.write("versioned.json", "two");
      const second = await driver.readVersioned("versioned.json");
      expect(second?.version).not.toBe(first?.version);
      expect(await driver.readVersioned("missing.json")).toBeNull();
    });

    it("writes only when the expected version still matches", async () => {
      const created = await driver.compareAndSwap("cas.json", "first", null);
      expect(created).toBe("written");

      const versioned = await driver.readVersioned("cas.json");
      expect(versioned?.version).toBeTruthy();

      // A stale expectation must not overwrite the object.
      expect(await driver.compareAndSwap("cas.json", "second", "stale-version")).toBe("conflict");
      expect(await driver.readText("cas.json")).toBe("first");

      // The current version may replace it.
      expect(await driver.compareAndSwap("cas.json", "second", versioned?.version ?? null)).toBe(
        "written",
      );
      expect(await driver.readText("cas.json")).toBe("second");
    });

    it("does not create an object twice", async () => {
      expect(await driver.compareAndSwap("once.json", "a", null)).toBe("written");
      expect(await driver.compareAndSwap("once.json", "b", null)).toBe("conflict");
      expect(await driver.readText("once.json")).toBe("a");
    });

    it("reports whether the backend supports conditional writes", async () => {
      expect(await driver.probeConditionalWrites()).toBe(true);
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

// The valkey contract runs against a real instance only when
// VALKEY_TEST_URL is set — the in-process fakes cannot prove Lua
// atomicity. CI and developers without a Valkey skip it; the Altare
// deployment is verified by the runbook drill instead.
const valkeyTestUrl = process.env.VALKEY_TEST_URL;
if (valkeyTestUrl) {
  describeContract("valkey (real instance)", async () => {
    const { createValkeyStorage } = await import("../src/lib/storage/valkey.js");
    return createValkeyStorage({
      prefix: `contract-${Date.now()}-`,
      url: valkeyTestUrl,
    });
  });

  // Corruption must surface as an error, never as "missing": the lease
  // relies on this to fail closed instead of overwriting a live term.
  describe("valkey corruption semantics", () => {
    it("throws on an unparseable envelope and refuses to CAS over it", async () => {
      const { createValkeyStorage } = await import("../src/lib/storage/valkey.js");
      const { createClient } = await import("redis");
      const prefix = `corrupt-${Date.now()}-`;
      const driver = createValkeyStorage({ prefix, url: valkeyTestUrl });
      const client = createClient({ url: valkeyTestUrl });
      await client.connect();
      try {
        await client.set(`${prefix}bad.json`, "not-an-envelope");
        await expect(driver.read("bad.json")).rejects.toThrow(/corrupt storage object/);
        await expect(driver.readVersioned("bad.json")).rejects.toThrow(/corrupt storage object/);
        // expectedVersion=null means "must not exist" — a corrupt object
        // exists, so the swap must conflict rather than overwrite it.
        await expect(driver.compareAndSwap("bad.json", "x", null)).resolves.toBe("conflict");
        // Unconditional write still replaces the corrupt value.
        await driver.write("bad.json", "ok");
        await expect(driver.readText("bad.json")).resolves.toBe("ok");
      } finally {
        await client.del(`${prefix}bad.json`).catch(() => undefined);
        await client.quit().catch(() => undefined);
      }
    });
  });
}
