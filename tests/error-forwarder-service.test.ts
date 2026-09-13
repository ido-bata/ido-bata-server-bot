import { describe, expect, it, vi } from "vitest";

import { errorForwarderConfig } from "../src/features/error-forwarder/config.js";
import { StackRateLimiter } from "../src/features/error-forwarder/rate-limit.js";
import { createErrorReporter } from "../src/features/error-forwarder/service.js";

describe("error-forwarder service", () => {
  function buildHarness(options: { channelId?: string; limit?: number } = {}) {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const sendEmbed = vi.fn(async () => undefined);
    const resolveChannel = vi.fn(async (channelId: string) =>
      channelId ? ({ id: channelId } as never) : null,
    );

    const fixedNow = new Date("2026-09-13T12:00:00.000Z");
    const limiter = new StackRateLimiter({
      maxPerWindow: options.limit ?? 3,
      windowMs: 60_000,
      now: () => fixedNow,
    });

    const config = {
      ...errorForwarderConfig,
      channelId: options.channelId ?? "channel-1",
      maxPerWindow: options.limit ?? 3,
      windowMs: 60_000,
    };

    const reporter = createErrorReporter(null, {
      config,
      logger,
      limiter,
      resolveChannel,
      sendEmbed,
      buildContext: (kind) => ({
        kind,
        timestamp: fixedNow,
        source: "test-bot@0.0.0",
      }),
    });

    return { reporter, logger, sendEmbed, resolveChannel, config, limiter };
  }

  it("forwards a uncaughtException to the resolved channel", async () => {
    const { reporter, sendEmbed, logger, resolveChannel } = buildHarness();

    const error = new Error("boom");
    error.stack = "Error: boom\n    at /app/foo.ts:1:1";
    await reporter.report(error, "uncaughtException");

    expect(sendEmbed).toHaveBeenCalledTimes(1);
    expect(resolveChannel).toHaveBeenCalledWith("channel-1");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("restart required"),
      expect.objectContaining({ kind: "uncaughtException", requiresRestart: true }),
    );
  });

  it("forwards an unhandledRejection with restart flag off", async () => {
    const { reporter, sendEmbed, logger } = buildHarness();

    await reporter.report("string rejection", "unhandledRejection");

    expect(sendEmbed).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("unhandledRejection"),
      expect.objectContaining({ kind: "unhandledRejection", requiresRestart: false }),
    );
  });

  it("rate-limits duplicate stacks beyond the configured budget", async () => {
    const { reporter, sendEmbed, logger } = buildHarness({ limit: 2 });

    const makeError = () => {
      const e = new Error("boom");
      e.stack = "Error: boom\n    at /app/foo.ts:1:1";
      return e;
    };

    await reporter.report(makeError(), "uncaughtException");
    await reporter.report(makeError(), "uncaughtException");
    await reporter.report(makeError(), "uncaughtException"); // denied

    expect(sendEmbed).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      "error-forwarder rate-limited",
      expect.objectContaining({ kind: "uncaughtException", seenInWindow: 2 }),
    );
  });

  it("falls back to logger when no channel id is configured", async () => {
    const { reporter, sendEmbed, logger } = buildHarness({ channelId: "" });

    await reporter.report(new Error("no channel"), "uncaughtException");

    expect(sendEmbed).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "error-forwarder channel not configured; logger-only fallback",
      expect.any(Object),
    );
  });

  it("falls back to logger when the channel cannot be resolved", async () => {
    const harness = buildHarness();
    // Replace the harness resolver with one that returns null, simulating a
    // deleted / unresolvable channel.
    const resolveChannel = vi.fn(async () => null);
    const fallbackReporter = createErrorReporter(null, {
      config: { ...errorForwarderConfig, channelId: "missing-channel" },
      logger: harness.logger,
      limiter: new StackRateLimiter({
        maxPerWindow: 3,
        windowMs: 60_000,
        now: () => new Date(),
      }),
      resolveChannel,
      sendEmbed: harness.sendEmbed,
      buildContext: (kind) => ({
        kind,
        timestamp: new Date(),
        source: "test-bot@0.0.0",
      }),
    });

    await fallbackReporter.report(new Error("channel gone"), "uncaughtException");

    expect(harness.sendEmbed).not.toHaveBeenCalled();
    expect(harness.logger.warn).toHaveBeenCalledWith(
      "error-forwarder channel not resolvable; logger-only fallback",
      expect.objectContaining({ channelId: "missing-channel" }),
    );
  });

  it("logs the delivery failure and swallows the sendEmbed exception", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const sendEmbed = vi.fn(async () => {
      throw new Error("network down");
    });
    const resolveChannel = vi.fn(async () => ({ id: "channel-1" }) as never);

    const reporter = createErrorReporter(null, {
      config: { ...errorForwarderConfig, channelId: "channel-1" },
      logger,
      limiter: new StackRateLimiter({
        maxPerWindow: 3,
        windowMs: 60_000,
        now: () => new Date(),
      }),
      resolveChannel,
      sendEmbed,
      buildContext: (kind) => ({
        kind,
        timestamp: new Date(),
        source: "test-bot@0.0.0",
      }),
    });

    await expect(
      reporter.report(new Error("send fail"), "uncaughtException"),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      "failed to deliver error-forwarder embed",
      expect.objectContaining({ channelId: "channel-1", sendError: "network down" }),
    );
  });

  it("resetLimiter clears the in-memory buckets", async () => {
    const { reporter, sendEmbed, limiter } = buildHarness({ limit: 1 });

    await reporter.report(new Error("first"), "uncaughtException");
    expect(sendEmbed).toHaveBeenCalledTimes(1);

    reporter.resetLimiter();
    expect(limiter.size()).toBe(0);

    await reporter.report(new Error("first"), "uncaughtException");
    expect(sendEmbed).toHaveBeenCalledTimes(2);
  });
});
