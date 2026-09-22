import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createConsentLogger } from "../../src/consent/logger.js";
import { createRootLogger, subscribe } from "../../src/lib/logger/index.js";

/**
 * The consent logger wraps a pino child logger. Pino's level methods
 * (info/warn/error/debug) rely on `this[Symbol(pino.msgPrefix)]` to apply
 * the parent's msgPrefix and `this[Symbol(pino.write)]` to emit the
 * record. Extracting the method and calling it without binding (e.g.
 * `const fn = logger[level]; fn(...args)`) drops `this` and crashes
 * inside pino's `LOG` helper with `TypeError: Cannot read properties of
 * undefined (reading 'Symbol(pino.msgPrefix)')`.
 *
 * These tests reproduce the failure and pin the contract: forwarding
 * through the wrapper must preserve `this` so the wrapped pino logger
 * behaves identically to calling it directly.
 */
describe("consent logger — pino this-binding", () => {
  let unsubscribe: (() => void) | undefined;

  beforeEach(() => {
    // `createRootLogger` only initializes once per module load. The
    // logger test resets the module via `vi.resetModules()`; here we
    // just need a real sink + child, so calling again is fine.
    createRootLogger({});
  });

  afterEach(() => {
    // Drop the subscriber registered inside each `it` so subsequent
    // tests start with a clean subscriber set. Adding a no-op instead
    // (an earlier draft) leaked one closure per test.
    unsubscribe?.();
    unsubscribe = undefined;
  });

  it("info() forwards through the consent wrapper without losing pino this-binding", async () => {
    const received: unknown[] = [];
    unsubscribe = subscribe((rec) => received.push(rec));

    const logger = createConsentLogger();
    expect(() => logger.info("consent-event")).not.toThrow();
    await flushPino();

    const messages = received
      .map((r) => (r as { message?: string }).message)
      .filter((m): m is string => typeof m === "string");
    expect(messages).toContain("consent-event");
  });

  it("warn() forwards without losing pino this-binding", async () => {
    const received: unknown[] = [];
    unsubscribe = subscribe((rec) => received.push(rec));

    const logger = createConsentLogger();
    expect(() => logger.warn("consent-warn")).not.toThrow();
    await flushPino();

    const messages = received
      .map((r) => (r as { message?: string }).message)
      .filter((m): m is string => typeof m === "string");
    expect(messages).toContain("consent-warn");
  });

  it("error() forwards with structured metadata without losing pino this-binding", async () => {
    const received: unknown[] = [];
    unsubscribe = subscribe((rec) => received.push(rec));

    const logger = createConsentLogger();
    expect(() => logger.error("consent-error", { err: new Error("boom") })).not.toThrow();
    await flushPino();

    const errored = received.find((r) => (r as { message?: string }).message === "consent-error");
    expect(errored).toBeDefined();
  });

  it("child().info() nests a sub-component tag without losing pino this-binding", async () => {
    const received: unknown[] = [];
    unsubscribe = subscribe((rec) => received.push(rec));

    const logger = createConsentLogger();
    const child = logger.child({ feature: "reconcile" });
    expect(() => child.info("child-event")).not.toThrow();
    await flushPino();

    const match = received.find((r) => (r as { message?: string }).message === "child-event");
    expect(match).toBeDefined();
    // The child binding should stamp a `component` field on the record —
    // this also confirms `this` survived into pino's emit path.
    const component = (match as { component?: string } | undefined)?.component;
    expect(component).toBe("reconcile");
  });
});

/**
 * Pino writes asynchronously through split2 → sink. Yield twice via
 * `setImmediate` so subscribers observe every record the test produced.
 */
function flushPino(): Promise<void> {
  return new Promise((r) => {
    setImmediate(() => {
      setImmediate(() => r());
    });
  });
}
