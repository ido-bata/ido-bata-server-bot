import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as LoggerModuleType from "../../src/lib/logger/index.js";

type LoggerModule = typeof LoggerModuleType;

/**
 * These tests treat `src/lib/logger/index.ts` as a module-level singleton
 * (parser, sink, ring, subscribers all live at module scope). To get clean
 * state between tests we reset the module cache in `beforeEach` and dynamic
 * re-import the module. Each test then has its own fresh ring buffer and
 * subscriber set.
 */
async function loadFresh(): Promise<LoggerModule> {
  vi.resetModules();
  // Re-import both files so the ring buffer / subscribers / parser are all
  // fresh — `index.ts` imports the ring module, so resetting both keeps
  // their internal state isolated.
  await import("../../src/lib/logger/ring-buffer.js");
  return import("../../src/lib/logger/index.js");
}

/**
 * Build an env that satisfies the minimal logger config (LOG_LEVEL +
 * LOG_RING_SIZE) and otherwise looks like a clean test environment.
 */
function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ...overrides,
  };
}

describe("lib/logger — root factory", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a usable pino logger from createRootLogger", async () => {
    const mod = await loadFresh();
    const logger = mod.createRootLogger(env({ LOG_LEVEL: "info" }));
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.child).toBe("function");
  });

  it("honors LOG_LEVEL (warn suppresses info)", async () => {
    const mod = await loadFresh();
    mod.createRootLogger(env({ LOG_LEVEL: "warn" }));

    const received: string[] = [];
    mod.subscribe((rec) => {
      const message = (rec as { message?: unknown }).message;
      if (typeof message === "string") {
        received.push(message);
      }
    });

    const logger = mod.getRootLogger();
    logger.info("hidden-info");
    logger.warn("visible-warn");

    // Allow pino to flush through the parser pipeline.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(received).not.toContain("hidden-info");
    expect(received).toContain("visible-warn");
  });
});

describe("lib/logger — child context binding", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("child.info() carries component from parent binding", async () => {
    const mod = await loadFresh();
    mod.createRootLogger(env({ LOG_LEVEL: "info" }));

    const received: string[] = [];
    mod.subscribe((rec) => {
      received.push(JSON.stringify(rec));
    });

    const logger = mod.childFor(mod.getRootLogger(), "composition-root");
    logger.info({ extra: 1 }, "hello");

    // Allow pino to flush through the parser pipeline.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(received.length).toBeGreaterThan(0);
    const last = received.at(-1) ?? "";
    expect(last).toContain('"component":"composition-root"');
    expect(last).toContain('"message":"hello"');
  });
});

describe("lib/logger — subscriber drain", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("subscribe() receives every emitted record", async () => {
    const mod = await loadFresh();
    mod.createRootLogger(env({ LOG_LEVEL: "info" }));

    const received: unknown[] = [];
    mod.subscribe((rec) => received.push(rec));

    const logger = mod.childFor(mod.getRootLogger(), "subscriber-drain");
    logger.info("one");
    logger.warn("two");
    logger.error("three");

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const messages = received
      .map((r) => (r as { message?: string }).message)
      .filter((m): m is string => typeof m === "string");
    expect(messages).toEqual(expect.arrayContaining(["one", "two", "three"]));
  });

  it("subscribe() returns an unsubscribe function", async () => {
    const mod = await loadFresh();
    mod.createRootLogger(env({ LOG_LEVEL: "info" }));

    const received: unknown[] = [];
    const unsubscribe = mod.subscribe((rec) => received.push(rec));
    unsubscribe();
    mod.getRootLogger().info("after-unsub");
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(received).toEqual([]);
  });
});

describe("lib/logger — subscriber failure isolation", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("one buggy subscriber does not affect others", async () => {
    const mod = await loadFresh();
    mod.createRootLogger(env({ LOG_LEVEL: "info" }));

    const received: unknown[] = [];
    mod.subscribe(() => {
      throw new Error("boom");
    });
    mod.subscribe((rec) => received.push(rec));

    // Must not throw out of the logger.
    expect(() => mod.getRootLogger().info("survives")).not.toThrow();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const messages = received
      .map((r) => (r as { message?: string }).message)
      .filter((m): m is string => typeof m === "string");
    expect(messages).toContain("survives");
  });
});

describe("lib/logger — ring buffer cap", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("LOG_RING_SIZE limit is enforced", async () => {
    const mod = await loadFresh();
    mod.createRootLogger(env({ LOG_LEVEL: "info", LOG_RING_SIZE: "10" }));

    const logger = mod.getRootLogger();
    for (let i = 0; i < 25; i += 1) {
      logger.info(`event-${i}`);
    }
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const snap = mod.snapshotRing();
    expect(snap.length).toBeLessThanOrEqual(10);
    // The most recent event should still be there; the oldest should have
    // been evicted by the cap.
    const messages = snap.map((s) => s.message).filter((m): m is string => typeof m === "string");
    expect(messages).toContain("event-24");
    expect(messages).not.toContain("event-0");
  });

  it("setRingSize() re-bounds the buffer at runtime", async () => {
    const mod = await loadFresh();
    mod.createRootLogger(env({ LOG_LEVEL: "info" }));

    const logger = mod.getRootLogger();
    for (let i = 0; i < 30; i += 1) {
      logger.info(`rt-${i}`);
    }
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    mod.setRingSize(10);
    for (let i = 30; i < 60; i += 1) {
      logger.info(`rt-${i}`);
    }
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(mod.snapshotRing().length).toBeLessThanOrEqual(10);
  });
});

describe("lib/logger — redact paths", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("DISCORD_TOKEN never appears in any subscriber output", async () => {
    const mod = await loadFresh();
    mod.createRootLogger(env({ LOG_LEVEL: "info" }));

    const received: unknown[] = [];
    mod.subscribe((rec) => received.push(rec));

    const sensitiveToken = "super-secret-discord-token-XYZ";
    const logger = mod.childFor(mod.getRootLogger(), "redact-test");
    logger.info(
      {
        discordToken: sensitiveToken,
        token: sensitiveToken,
        password: sensitiveToken,
      },
      "redact-me",
    );

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const serialized = JSON.stringify(received);
    expect(serialized).not.toContain(sensitiveToken);
    // The non-sensitive fields still come through.
    expect(serialized).toContain("redact-me");
  });
});

describe("lib/logger — JSON Lines output on non-TTY", () => {
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    vi.resetModules();
    originalIsTTY = process.stdout.isTTY;
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      configurable: true,
      writable: true,
    });
  });

  it("emits single-line JSON per record on non-TTY stdout", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: undefined,
      configurable: true,
      writable: true,
    });

    const mod = await loadFresh();
    mod.createRootLogger(env({ LOG_LEVEL: "info" }));

    const captured: string[] = [];
    mod.subscribe((rec) => {
      // Subscribers see the parsed object; serializing once yields exactly
      // one JSON value with no embedded newlines (JSON Lines format).
      captured.push(JSON.stringify(rec));
    });

    const logger = mod.getRootLogger();
    logger.info("first");
    logger.info("second");
    logger.info("third");
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(captured.length).toBeGreaterThanOrEqual(3);
    for (const line of captured.slice(0, 3)) {
      expect(line.includes("\n")).toBe(false);
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // isInteractive must return false in this environment so consumers know
    // to render the JSON-line stream rather than running pino-pretty.
    expect(mod.isInteractive()).toBe(false);
  });
});

describe("lib/logger — isInteractive", () => {
  let originalStdout: boolean | undefined;
  let originalStdin: boolean | undefined;
  let originalTerm: string | undefined;
  let originalCi: string | undefined;

  beforeEach(() => {
    originalStdout = process.stdout.isTTY;
    originalStdin = process.stdin.isTTY;
    originalTerm = process.env.TERM;
    originalCi = process.env.CI;
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalStdout,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalStdin,
      configurable: true,
      writable: true,
    });
    if (originalTerm === undefined) {
      delete process.env.TERM;
    } else {
      process.env.TERM = originalTerm;
    }
    if (originalCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCi;
    }
  });

  function setTty(stdout: boolean | undefined, stdin: boolean | undefined): void {
    Object.defineProperty(process.stdout, "isTTY", {
      value: stdout,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: stdin,
      configurable: true,
      writable: true,
    });
  }

  it("returns true for full TTY environment with no CI flag", async () => {
    setTty(true, true);
    delete process.env.CI;
    process.env.TERM = "xterm-256color";

    const mod = await loadFresh();
    expect(mod.isInteractive()).toBe(true);
  });

  it("returns false when stdout is not a TTY", async () => {
    setTty(false, true);
    delete process.env.CI;
    process.env.TERM = "xterm-256color";

    const mod = await loadFresh();
    expect(mod.isInteractive()).toBe(false);
  });

  it("returns false when CI=true", async () => {
    setTty(true, true);
    process.env.CI = "true";
    process.env.TERM = "xterm-256color";

    const mod = await loadFresh();
    expect(mod.isInteractive()).toBe(false);
  });

  it("returns false when TERM=dumb", async () => {
    setTty(true, true);
    delete process.env.CI;
    process.env.TERM = "dumb";

    const mod = await loadFresh();
    expect(mod.isInteractive()).toBe(false);
  });

  it("returns false when stdin is not a TTY", async () => {
    setTty(true, false);
    delete process.env.CI;
    process.env.TERM = "xterm-256color";

    const mod = await loadFresh();
    expect(mod.isInteractive()).toBe(false);
  });
});
