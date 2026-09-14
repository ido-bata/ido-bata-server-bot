import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StackRateLimiter } from "../src/features/error-forwarder/rate-limit.js";

describe("StackRateLimiter", () => {
  let now: Date;

  beforeEach(() => {
    now = new Date("2026-09-13T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function advance(ms: number): void {
    now = new Date(now.getTime() + ms);
    vi.setSystemTime(now);
  }

  it("allows up to maxPerWindow hits per stack within the window", () => {
    const limiter = new StackRateLimiter({
      maxPerWindow: 3,
      windowMs: 60_000,
      now: () => new Date(),
    });

    expect(limiter.hit("stack-a").allowed).toBe(true);
    expect(limiter.hit("stack-a").allowed).toBe(true);
    expect(limiter.hit("stack-a").allowed).toBe(true);

    const denied = limiter.hit("stack-a");
    expect(denied.allowed).toBe(false);
    expect(denied.seenInWindow).toBe(3);
    expect(denied.resetsAt.getTime()).toBe(now.getTime() + 60_000);
  });

  it("tracks stacks independently", () => {
    const limiter = new StackRateLimiter({
      maxPerWindow: 1,
      windowMs: 60_000,
      now: () => new Date(),
    });

    expect(limiter.hit("stack-a").allowed).toBe(true);
    expect(limiter.hit("stack-a").allowed).toBe(false);
    expect(limiter.hit("stack-b").allowed).toBe(true);
    expect(limiter.hit("stack-b").allowed).toBe(false);
  });

  it("frees capacity once the window slides past the oldest hit", () => {
    const limiter = new StackRateLimiter({
      maxPerWindow: 3,
      windowMs: 60_000,
      now: () => new Date(),
    });

    limiter.hit("stack-a");
    limiter.hit("stack-a");
    limiter.hit("stack-a");
    expect(limiter.hit("stack-a").allowed).toBe(false);

    advance(60_001);

    const decision = limiter.hit("stack-a");
    expect(decision.allowed).toBe(true);
    expect(decision.seenInWindow).toBe(1);
  });

  it("does not record timestamps for denied hits", () => {
    const limiter = new StackRateLimiter({
      maxPerWindow: 2,
      windowMs: 60_000,
      now: () => new Date(),
    });

    limiter.hit("stack-a");
    advance(10_000);
    limiter.hit("stack-a");
    // Both hits fall inside the window — the next ones are denied and do not
    // extend the back-pressure horizon.
    for (let i = 0; i < 5; i++) {
      advance(5_000);
      expect(limiter.hit("stack-a").allowed).toBe(false);
    }

    // After the original window expires, the limiter should accept again.
    advance(60_000);
    expect(limiter.hit("stack-a").allowed).toBe(true);
  });

  it("reset clears every tracked bucket", () => {
    const limiter = new StackRateLimiter({
      maxPerWindow: 1,
      windowMs: 60_000,
      now: () => new Date(),
    });

    limiter.hit("stack-a");
    expect(limiter.hit("stack-a").allowed).toBe(false);
    expect(limiter.size()).toBe(1);

    limiter.reset();

    expect(limiter.size()).toBe(0);
    expect(limiter.hit("stack-a").allowed).toBe(true);
  });
});
