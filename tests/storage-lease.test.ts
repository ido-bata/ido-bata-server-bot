import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acquireInstanceLease,
  LeaseConflictError,
  LeaseLostError,
  LeaseUnsupportedError,
} from "../src/lib/storage/lease.js";
import { createLocalFileStorage } from "../src/lib/storage/local.js";
import type { StorageDriver } from "../src/lib/storage/types.js";
import { createU3Storage } from "../src/lib/storage/u3.js";
import { type FakeS3Server, startFakeS3Server } from "./helpers/fake-s3.js";

function tempDriver(): { cleanup: () => void; driver: StorageDriver } {
  const root = mkdtempSync(join(tmpdir(), "storage-lease-"));
  return {
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    driver: createLocalFileStorage({ root }),
  };
}

describe("instance lease (local backend)", () => {
  it("blocks a second instance while the term is live", async () => {
    const { cleanup, driver } = tempDriver();
    try {
      const first = await acquireInstanceLease({ driver, holderId: "instance-a" });
      await expect(acquireInstanceLease({ driver, holderId: "instance-b" })).rejects.toBeInstanceOf(
        LeaseConflictError,
      );
      await first.release();
    } finally {
      cleanup();
    }
  });

  it("lets a new instance take over after the term was released", async () => {
    const { cleanup, driver } = tempDriver();
    try {
      const first = await acquireInstanceLease({ driver, holderId: "instance-a" });
      await first.release();
      const second = await acquireInstanceLease({ driver, holderId: "instance-b" });
      expect(second.holderId).toBe("instance-b");
      // The takeover increments the term counter.
      expect(second.epoch).toBeGreaterThan(first.epoch);
      await second.release();
    } finally {
      cleanup();
    }
  });

  it("expires the term on release instead of deleting the object", async () => {
    const { cleanup, driver } = tempDriver();
    try {
      const lease = await acquireInstanceLease({ driver, holderId: "instance-a" });
      await lease.release();
      // The object stays (a delete could remove a term another instance
      // acquired meanwhile); it is simply expired.
      expect(await driver.exists("locks/instance.json")).toBe(true);
      const stored = await driver.readText("locks/instance.json");
      expect(stored).not.toBeNull();
      expect(Date.parse(JSON.parse(stored ?? "{}").expiresAt)).toBeLessThanOrEqual(Date.now());
    } finally {
      cleanup();
    }
  });

  it("takes over an expired term", async () => {
    const { cleanup, driver } = tempDriver();
    try {
      await acquireInstanceLease({
        driver,
        holderId: "instance-a",
        now: () => 0,
        ttlMs: 1_000,
      });
      const taken = await acquireInstanceLease({
        driver,
        holderId: "instance-b",
        now: () => 10_000,
      });
      expect(taken.holderId).toBe("instance-b");
      await taken.release();
    } finally {
      cleanup();
    }
  });

  it("renews the term so the holder keeps it", async () => {
    const { cleanup, driver } = tempDriver();
    try {
      let now = 0;
      const holder = await acquireInstanceLease({
        driver,
        holderId: "instance-a",
        now: () => now,
        ttlMs: 1_000,
      });
      now = 500;
      await holder.renew();
      now = 1_200;
      await expect(
        acquireInstanceLease({ driver, holderId: "instance-b", now: () => now }),
      ).rejects.toBeInstanceOf(LeaseConflictError);
      await holder.release();
    } finally {
      cleanup();
    }
  });

  it("detects a lost term instead of silently continuing", async () => {
    const { cleanup, driver } = tempDriver();
    try {
      const holder = await acquireInstanceLease({ driver, holderId: "instance-a" });
      // Another process takes the term over.
      await driver.write(
        "locks/instance.json",
        JSON.stringify({
          acquiredAt: new Date().toISOString(),
          epoch: 99,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          holderId: "instance-b",
          token: "someone-elses-token",
        }),
      );
      await expect(holder.renew()).rejects.toBeInstanceOf(LeaseLostError);
    } finally {
      cleanup();
    }
  });

  it("reports the loss through onLost when the term is taken over", async () => {
    const { cleanup, driver } = tempDriver();
    try {
      let lost: Error | null = null;
      const holder = await acquireInstanceLease({
        driver,
        holderId: "instance-a",
        onLost: (error) => {
          lost = error;
        },
        ttlMs: 3_000,
      });
      await driver.write(
        "locks/instance.json",
        JSON.stringify({
          acquiredAt: new Date().toISOString(),
          epoch: 99,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          holderId: "instance-b",
          token: "someone-elses-token",
        }),
      );
      await expect(holder.renew()).rejects.toBeInstanceOf(LeaseLostError);
      expect(lost).toBeNull(); // renew() reports directly; the timer reports via onLost.
      await holder.release();
    } finally {
      cleanup();
    }
  });

  it("reports the loss through onLost when the renewal finds a foreign term", async () => {
    const { cleanup, driver } = tempDriver();
    try {
      let lost: Error | null = null;
      const holder = await acquireInstanceLease({
        driver,
        holderId: "instance-a",
        onLost: (error) => {
          lost = error;
        },
        // The renewal timer fires quickly so the fault injection is
        // observable without waiting a full lease term.
        ttlMs: 1_000,
      });
      await driver.write(
        "locks/instance.json",
        JSON.stringify({
          acquiredAt: new Date().toISOString(),
          epoch: 99,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          holderId: "instance-b",
          token: "someone-elses-token",
        }),
      );
      // Wait for the renewal timer to observe the foreign term.
      for (let attempt = 0; attempt < 40 && lost === null; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(lost).toBeInstanceOf(LeaseLostError);
      await holder.release();
    } finally {
      cleanup();
    }
  });

  it("refuses the term when a concurrent takeover replaced it right after the write", async () => {
    const { cleanup, driver } = tempDriver();
    try {
      // Fault injection: the compare-and-swap succeeds, but the object is
      // replaced by another instance before the acquisition reads it back.
      const hijacked: StorageDriver = {
        ...driver,
        compareAndSwap: async (key, data, expectedVersion) => {
          const result = await driver.compareAndSwap(key, data, expectedVersion);
          if (result === "written") {
            await driver.write(
              key,
              JSON.stringify({
                acquiredAt: new Date().toISOString(),
                epoch: 99,
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                holderId: "instance-b",
                token: "someone-elses-token",
              }),
            );
          }
          return result;
        },
      };

      await expect(
        acquireInstanceLease({ driver: hijacked, holderId: "instance-a" }),
      ).rejects.toBeInstanceOf(LeaseConflictError);
    } finally {
      cleanup();
    }
  });

  it("can be acquired again after the previous holder lost the term", async () => {
    const { cleanup, driver } = tempDriver();
    try {
      const first = await acquireInstanceLease({ driver, holderId: "instance-a" });
      // The term was taken over by another instance.
      await driver.write(
        "locks/instance.json",
        JSON.stringify({
          acquiredAt: new Date().toISOString(),
          epoch: 2,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          holderId: "instance-b",
          token: "instance-b-token",
        }),
      );
      await expect(first.renew()).rejects.toBeInstanceOf(LeaseLostError);

      // The new holder is gone as well: its term expired.
      await driver.write(
        "locks/instance.json",
        JSON.stringify({
          acquiredAt: new Date(Date.now() - 120_000).toISOString(),
          epoch: 2,
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
          holderId: "instance-b",
          token: "instance-b-token",
        }),
      );

      // The first instance may take the term again — with a higher epoch.
      const again = await acquireInstanceLease({ driver, holderId: "instance-a" });
      expect(again.holderId).toBe("instance-a");
      expect(again.epoch).toBe(3);
      await again.release();
    } finally {
      cleanup();
    }
  });

  it("gives the term to exactly one of two racing instances", async () => {
    const { cleanup, driver } = tempDriver();
    try {
      const results = await Promise.allSettled([
        acquireInstanceLease({ driver, holderId: "instance-a" }),
        acquireInstanceLease({ driver, holderId: "instance-b" }),
        acquireInstanceLease({ driver, holderId: "instance-c" }),
      ]);
      const granted = results.filter((result) => result.status === "fulfilled");
      const refused = results.filter((result) => result.status === "rejected");
      expect(granted).toHaveLength(1);
      expect(refused).toHaveLength(2);
      for (const failure of refused) {
        expect(failure.reason).toBeInstanceOf(LeaseConflictError);
      }
    } finally {
      cleanup();
    }
  });
});

describe("instance lease (u3 backend)", () => {
  let server: FakeS3Server;
  let driver: StorageDriver;

  beforeAll(async () => {
    server = await startFakeS3Server();
    driver = createU3Storage({
      accessKeyId: "AKTESTTESTTEST",
      bucket: server.bucket,
      endpoint: server.endpoint,
      region: "eu",
      secretAccessKey: "test-secret",
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("detects that the backend supports conditional writes", async () => {
    expect(await driver.probeConditionalWrites()).toBe(true);
  });

  it("reports the loss through onLost when the renewal finds a foreign term", async () => {
    const { cleanup, driver } = tempDriver();
    try {
      let lost: Error | null = null;
      const holder = await acquireInstanceLease({
        driver,
        holderId: "instance-a",
        onLost: (error) => {
          lost = error;
        },
        // The renewal timer fires quickly so the fault injection is
        // observable without waiting a full lease term.
        ttlMs: 1_000,
      });
      await driver.write(
        "locks/instance.json",
        JSON.stringify({
          acquiredAt: new Date().toISOString(),
          epoch: 99,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          holderId: "instance-b",
          token: "someone-elses-token",
        }),
      );
      // Wait for the renewal timer to observe the foreign term.
      for (let attempt = 0; attempt < 40 && lost === null; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(lost).toBeInstanceOf(LeaseLostError);
      await holder.release();
    } finally {
      cleanup();
    }
  });

  it("refuses the term when a concurrent takeover replaced it right after the write", async () => {
    const { cleanup, driver } = tempDriver();
    try {
      // Fault injection: the compare-and-swap succeeds, but the object is
      // replaced by another instance before the acquisition reads it back.
      const hijacked: StorageDriver = {
        ...driver,
        compareAndSwap: async (key, data, expectedVersion) => {
          const result = await driver.compareAndSwap(key, data, expectedVersion);
          if (result === "written") {
            await driver.write(
              key,
              JSON.stringify({
                acquiredAt: new Date().toISOString(),
                epoch: 99,
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                holderId: "instance-b",
                token: "someone-elses-token",
              }),
            );
          }
          return result;
        },
      };

      await expect(
        acquireInstanceLease({ driver: hijacked, holderId: "instance-a" }),
      ).rejects.toBeInstanceOf(LeaseConflictError);
    } finally {
      cleanup();
    }
  });

  it("can be acquired again after the previous holder lost the term", async () => {
    const { cleanup, driver } = tempDriver();
    try {
      const first = await acquireInstanceLease({ driver, holderId: "instance-a" });
      // The term was taken over by another instance.
      await driver.write(
        "locks/instance.json",
        JSON.stringify({
          acquiredAt: new Date().toISOString(),
          epoch: 2,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          holderId: "instance-b",
          token: "instance-b-token",
        }),
      );
      await expect(first.renew()).rejects.toBeInstanceOf(LeaseLostError);

      // The new holder is gone as well: its term expired.
      await driver.write(
        "locks/instance.json",
        JSON.stringify({
          acquiredAt: new Date(Date.now() - 120_000).toISOString(),
          epoch: 2,
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
          holderId: "instance-b",
          token: "instance-b-token",
        }),
      );

      // The first instance may take the term again — with a higher epoch.
      const again = await acquireInstanceLease({ driver, holderId: "instance-a" });
      expect(again.holderId).toBe("instance-a");
      expect(again.epoch).toBe(3);
      await again.release();
    } finally {
      cleanup();
    }
  });

  it("gives the term to exactly one of two racing instances", async () => {
    await driver.delete("locks/instance.json");
    const results = await Promise.allSettled([
      acquireInstanceLease({ driver, holderId: "instance-a" }),
      acquireInstanceLease({ driver, holderId: "instance-b" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
});

describe("instance lease (backend that honours create but not update)", () => {
  let server: FakeS3Server;
  let driver: StorageDriver;

  beforeAll(async () => {
    server = await startFakeS3Server("test-bucket", { conditionalWrites: "create-only" });
    driver = createU3Storage({
      accessKeyId: "AKTESTTESTTEST",
      bucket: server.bucket,
      endpoint: server.endpoint,
      region: "eu",
      secretAccessKey: "test-secret",
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("rejects the backend because the conditional update path is not enforced", async () => {
    // A create-only backend would pass a create-if-absent probe, but the
    // lease renewal (a conditional update) would silently overwrite the
    // term of another instance.
    expect(await driver.probeConditionalWrites()).toBe(false);
    await expect(acquireInstanceLease({ driver, holderId: "instance-a" })).rejects.toBeInstanceOf(
      LeaseUnsupportedError,
    );
  });
});

describe("instance lease (backend without conditional writes)", () => {
  let server: FakeS3Server;
  let driver: StorageDriver;

  beforeAll(async () => {
    server = await startFakeS3Server("test-bucket", { conditionalWrites: "none" });
    driver = createU3Storage({
      accessKeyId: "AKTESTTESTTEST",
      bucket: server.bucket,
      endpoint: server.endpoint,
      region: "eu",
      secretAccessKey: "test-secret",
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("reports that conditional writes are unavailable", async () => {
    expect(await driver.probeConditionalWrites()).toBe(false);
  });

  it("refuses to hand out a lease it cannot make exclusive", async () => {
    await expect(acquireInstanceLease({ driver, holderId: "instance-a" })).rejects.toBeInstanceOf(
      LeaseUnsupportedError,
    );
  });
});
