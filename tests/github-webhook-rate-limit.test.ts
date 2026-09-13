import { describe, expect, it } from "vitest";

import { GitHubWebhookRateLimiter } from "../src/features/github-webhook/rate-limit.js";

describe("GitHub webhook rate limiter", () => {
  it("allows the first delivery per repo", () => {
    const limiter = new GitHubWebhookRateLimiter(60_000);

    expect(limiter.check("acme/widget", 1_000).allowed).toBe(true);
  });

  it("throttles a second delivery inside the window", () => {
    const limiter = new GitHubWebhookRateLimiter(60_000);

    expect(limiter.check("acme/widget", 1_000).allowed).toBe(true);
    const second = limiter.check("acme/widget", 1_500);
    expect(second.allowed).toBe(false);
    if (!second.allowed) {
      expect(second.retryAfterMs).toBe(60_000 - 500);
    }
  });

  it("lets through another delivery after the window passes", () => {
    const limiter = new GitHubWebhookRateLimiter(60_000);

    expect(limiter.check("acme/widget", 1_000).allowed).toBe(true);
    expect(limiter.check("acme/widget", 1_500).allowed).toBe(false);
    expect(limiter.check("acme/widget", 61_500).allowed).toBe(true);
  });

  it("tracks repos independently", () => {
    const limiter = new GitHubWebhookRateLimiter(60_000);

    expect(limiter.check("acme/widget", 1_000).allowed).toBe(true);
    expect(limiter.check("acme/other", 1_000).allowed).toBe(true);
    expect(limiter.check("acme/widget", 1_500).allowed).toBe(false);
    expect(limiter.check("acme/other", 1_500).allowed).toBe(false);
  });

  it("rejects an invalid window", () => {
    expect(() => new GitHubWebhookRateLimiter(Number.NaN)).toThrow();
    expect(() => new GitHubWebhookRateLimiter(-1)).toThrow();
  });
});