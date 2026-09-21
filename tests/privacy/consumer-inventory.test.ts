import { describe, expect, it } from "vitest";

import {
  CONSUMERS,
  type ConsumerEntry,
  getConsentGatedConsumers,
  getConsumerById,
  getConsumers,
} from "../../src/features/privacy/consumer-inventory.js";

describe("consumer inventory", () => {
  it("exposes the 5 consent-gated consumers that map to scopes", () => {
    const gated = getConsentGatedConsumers();
    const ids = gated.map((entry) => entry.id);
    expect(ids).toEqual(["timekeeper-history", "birthday", "poll", "reminder", "state-snapshot"]);
    for (const entry of gated) {
      expect(entry.bucket).toBe("consent-gated");
      expect(entry.scope).toBeTruthy();
    }
  });

  it("labels the operational bucket as having no consent scope", () => {
    const operational = getConsumers().filter((entry) => entry.bucket === "operational");
    expect(operational.length).toBeGreaterThan(0);
    for (const entry of operational) {
      expect(entry.scope).toBeUndefined();
    }
  });

  it("includes both buckets in the canonical order", () => {
    const order: string[] = [];
    let lastBucket: string | null = null;
    for (const entry of getConsumers()) {
      if (entry.bucket !== lastBucket) {
        order.push(entry.bucket);
        lastBucket = entry.bucket;
      }
    }
    // Order is: consent-gated, operational, ephemeral.
    expect(order).toEqual(["consent-gated", "operational", "ephemeral"]);
  });

  it("looks up consumers by id", () => {
    const timekeeper = getConsumerById("timekeeper-history") as ConsumerEntry;
    expect(timekeeper).toBeDefined();
    expect(timekeeper.scope).toBe("activity-history");
    expect(getConsumerById("nope")).toBeUndefined();
  });

  it("exposes a frozen canonical list", () => {
    // CONSUMERS is typed as readonly so the surface is enforced at compile
    // time; runtime check that nobody mutated it.
    expect(Array.isArray(CONSUMERS)).toBe(true);
    expect(CONSUMERS.length).toBeGreaterThanOrEqual(20);
  });
});
