import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireInstanceLease, LeaseConflictError } from "../src/lib/storage/lease.js";
import { createLocalFileStorage } from "../src/lib/storage/local.js";

function tempDriver() {
  const root = mkdtempSync(join(tmpdir(), "storage-lease-"));
  return {
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    driver: createLocalFileStorage({ root }),
  };
}

describe("instance lease", () => {
  it("blocks a second instance while the lease is live", async () => {
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

  it("allows a new instance after the lease was released", async () => {
    const { cleanup, driver } = tempDriver();
    try {
      const first = await acquireInstanceLease({ driver, holderId: "instance-a" });
      await first.release();
      const second = await acquireInstanceLease({ driver, holderId: "instance-b" });
      expect(second.holderId).toBe("instance-b");
      await second.release();
    } finally {
      cleanup();
    }
  });

  it("takes over an expired lease", async () => {
    const { cleanup, driver } = tempDriver();
    try {
      const stale = await acquireInstanceLease({
        driver,
        holderId: "instance-a",
        now: () => 0,
        ttlMs: 1_000,
      });
      // The holder "crashed": the lease is expired but still present.
      const taken = await acquireInstanceLease({
        driver,
        holderId: "instance-b",
        now: () => 10_000,
      });
      expect(taken.holderId).toBe("instance-b");
      await taken.release();
      void stale;
    } finally {
      cleanup();
    }
  });

  it("renews the lease so the holder keeps it", async () => {
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
      // Still inside the renewed term — a competitor must be refused.
      await expect(
        acquireInstanceLease({ driver, holderId: "instance-b", now: () => now }),
      ).rejects.toBeInstanceOf(LeaseConflictError);
      await holder.release();
    } finally {
      cleanup();
    }
  });

  it("reports a lost lease instead of silently continuing", async () => {
    const { cleanup, driver } = tempDriver();
    try {
      const holder = await acquireInstanceLease({ driver, holderId: "instance-a" });
      // Another process takes the lease over.
      await driver.write(
        "locks/instance.json",
        JSON.stringify({
          acquiredAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          holderId: "instance-b",
        }),
      );
      await expect(holder.renew()).rejects.toThrow(/taken over/);
    } finally {
      cleanup();
    }
  });
});
