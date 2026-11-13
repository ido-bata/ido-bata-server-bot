import { describe, expect, it } from "vitest";

import { AnonCooldown } from "../src/features/anonymous-chat/rate-limit.js";

describe("AnonCooldown", () => {
  it("allows the first attempt and blocks within the window", () => {
    let now = 1_000;
    const cooldown = new AnonCooldown(30_000, () => now);

    expect(cooldown.hit("u1")).toBe(0);
    expect(cooldown.hit("u1")).toBeGreaterThan(0);

    now += 29_999;
    expect(cooldown.hit("u1")).toBe(1);

    now += 1;
    expect(cooldown.hit("u1")).toBe(0);
  });

  it("tracks users independently", () => {
    const cooldown = new AnonCooldown(30_000, () => 0);
    expect(cooldown.hit("u1")).toBe(0);
    expect(cooldown.hit("u2")).toBe(0);
    expect(cooldown.hit("u1")).toBeGreaterThan(0);
    expect(cooldown.hit("u2")).toBeGreaterThan(0);
  });

  it("prunes expired entries once the map grows", () => {
    let now = 0;
    const cooldown = new AnonCooldown(1_000, () => now);
    for (let i = 0; i < 10_500; i += 1) {
      cooldown.hit(`bulk-${i}`);
    }
    now += 2_000;
    // Trigger a prune pass via a fresh hit.
    cooldown.hit("trigger");
    expect(cooldown.size).toBeLessThan(100);
  });
});
