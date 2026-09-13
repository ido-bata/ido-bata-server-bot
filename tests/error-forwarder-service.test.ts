import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { errorForwarderConfig } from "../src/features/error-forwarder/config.js";
import { StackRateLimiter } from "../src/features/error-forwarder/rate-limit.js";
import {
  createErrorReporter,
  registerErrorForwarder,
} from "../src/features/error-forwarder/service.js";

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

describe("error-forwarder registerErrorForwarder", () => {
  function captureExit(): {
    exitProcess: (code: number) => never;
    whenExited: Promise<number>;
  } {
    let resolveExit: (code: number) => void = () => {};
    const whenExited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const exitProcess = (code: number) => {
      resolveExit(code);
      // Returning `never` keeps the signature; tests await `whenExited`
      // instead of relying on the (would-be) exit side-effect.
      return undefined as never;
    };
    return { exitProcess, whenExited };
  }

  // Tests below attach real listeners via `process.on(...)`. Snapshot the
  // count before each registration so we can clean up exactly the listeners
  // this suite added without disturbing unrelated test plumbing.
  let baselineUncaught = 0;
  let baselineRejection = 0;

  beforeEach(() => {
    baselineUncaught = process.listenerCount("uncaughtException");
    baselineRejection = process.listenerCount("unhandledRejection");
  });

  afterEach(() => {
    // Only strip the listener this suite added — never touch anyone else's.
    while (process.listenerCount("uncaughtException") > baselineUncaught) {
      const last = process.listeners("uncaughtException").pop();
      if (!last) break;
      process.removeListener("uncaughtException", last);
    }
    while (process.listenerCount("unhandledRejection") > baselineRejection) {
      const last = process.listeners("unhandledRejection").pop();
      if (!last) break;
      process.removeListener("unhandledRejection", last);
    }
  });

  function registerHarness(options: { fatal: boolean; exitProcess: (code: number) => never }) {
    const listenersBefore = process.listenerCount("uncaughtException");
    const config = {
      ...errorForwarderConfig,
      channelId: "channel-1",
      uncaughtExceptionIsFatal: options.fatal,
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sendEmbed = vi.fn(async () => undefined);
    const resolveChannel = vi.fn(async () => ({ id: "channel-1" }) as never);
    const limiter = new StackRateLimiter({ maxPerWindow: 3, windowMs: 60_000 });

    const reporter = registerErrorForwarder(null as never, {
      config,
      logger,
      limiter,
      resolveChannel,
      sendEmbed,
      exitProcess: options.exitProcess,
    });

    expect(process.listenerCount("uncaughtException")).toBe(listenersBefore + 1);
    expect(process.listenerCount("unhandledRejection")).toBe(listenersBefore + 1);

    return { reporter, logger, sendEmbed, resolveChannel };
  }

  it("exits with code 1 after a successful report when uncaughtExceptionIsFatal is true", async () => {
    const { exitProcess, whenExited } = captureExit();
    const { sendEmbed } = registerHarness({ fatal: true, exitProcess });

    const error = new Error("boom");
    error.stack = "Error: boom\n    at /app/foo.ts:1:1";
    process.emit("uncaughtException", error);

    await expect(whenExited).resolves.toBe(1);
    expect(sendEmbed).toHaveBeenCalledTimes(1);
  });

  it("does not exit when uncaughtExceptionIsFatal is false", async () => {
    const exitSpy = vi.fn(() => undefined as never);
    registerHarness({ fatal: false, exitProcess: exitSpy });

    const error = new Error("non-fatal");
    error.stack = "Error: non-fatal\n    at /app/foo.ts:1:1";
    process.emit("uncaughtException", error);

    // Give the async chain a chance to settle. Vitest's `await` resolution
    // happens once all microtasks drain, which is enough time for the
    // listener's `.finally` to have run if it was going to.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("still exits when the best-effort report itself rejects", async () => {
    const { exitProcess, whenExited } = captureExit();
    const sendEmbed = vi.fn(async () => {
      throw new Error("network down");
    });

    const config = {
      ...errorForwarderConfig,
      channelId: "channel-1",
      uncaughtExceptionIsFatal: true,
    };
    const baseline = process.listenerCount("uncaughtException");
    registerErrorForwarder(null as never, {
      config,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      limiter: new StackRateLimiter({ maxPerWindow: 3, windowMs: 60_000 }),
      resolveChannel: vi.fn(async () => ({ id: "channel-1" }) as never),
      sendEmbed,
      exitProcess,
    });
    expect(process.listenerCount("uncaughtException")).toBe(baseline + 1);

    const error = new Error("boom");
    error.stack = "Error: boom\n    at /app/foo.ts:1:1";
    process.emit("uncaughtException", error);

    await expect(whenExited).resolves.toBe(1);
    expect(sendEmbed).toHaveBeenCalledTimes(1);
  });

  it("never exits the process on an unhandledRejection", async () => {
    const exitSpy = vi.fn(() => undefined as never);
    registerHarness({ fatal: true, exitProcess: exitSpy });

    process.emit("unhandledRejection", "rejection reason");

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
