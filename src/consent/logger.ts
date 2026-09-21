/**
 * Consent-scoped logger.
 *
 * Thin wrapper over the project-wide structured logger (`src/lib/logger`).
 * Kept as a separate module so the consent subsystem never imports `pino`
 * directly — when the global logger destination changes (stdout tee, TUI
 * routing, redaction paths), the consent module follows for free.
 *
 * Returning `noopLogger` when `enabled: false` lets unit tests opt out of
 * log output without touching the global ring buffer.
 */
import { childFor, getRootLogger } from "../lib/logger/index.js";

export type ConsentLogger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  child: (bindings: Record<string, unknown>) => ConsentLogger;
};

const NOOP = (): void => {};

const noopLogger: ConsentLogger = {
  info: NOOP,
  warn: NOOP,
  error: NOOP,
  debug: NOOP,
  child: () => noopLogger,
};

type Level = "info" | "warn" | "error" | "debug";

function wrap(base: ReturnType<typeof childFor>): ConsentLogger {
  return {
    info: (...args: unknown[]) => forward(base, "info", args),
    warn: (...args: unknown[]) => forward(base, "warn", args),
    error: (...args: unknown[]) => forward(base, "error", args),
    debug: (...args: unknown[]) => forward(base, "debug", args),
    child: (bindings: Record<string, unknown>) => {
      // pino child bindings must be primitive (string/number/bool). We
      // accept the first string-valued binding as the sub-component tag.
      const tag =
        typeof bindings.feature === "string"
          ? bindings.feature
          : typeof bindings.component === "string"
            ? bindings.component
            : "consent-child";
      return wrap(childFor(base, tag));
    },
  };
}

function forward(logger: ReturnType<typeof childFor>, level: Level, args: unknown[]): void {
  // Pino natively accepts `(mergingObject, msg, ...interpolationValues)`.
  // Forward the common `(message, { error: ... })` shape so structured
  // metadata lands on the top-level log record (matching the rest of the
  // project) instead of being buried under `extra[0]`.
  const [first, second, ...rest] = toPinoArgs(args);
  const fn = logger[level] as (...a: unknown[]) => void;
  fn(first, second, ...rest);
}

function toPinoArgs(args: unknown[]): unknown[] {
  if (args.length === 0) {
    return [""];
  }
  const [first, second] = args;
  if (args.length === 1) {
    if (first && typeof first === "object") {
      return [first];
    }
    return [stringify(first)];
  }
  if (second && typeof second === "object") {
    return [second, stringify(first)];
  }
  return [{ extra: args.slice(1).map((value) => stringify(value)) }, stringify(first)];
}

function stringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Build a consent logger. When `enabled` is `false` (default), returns a
 * silent logger so unit tests + production boot with `LOG_LEVEL=silent`
 * do not spew JSON to stdout.
 *
 * The live variant is a `child` of the project-wide root logger, so all
 * consent records flow through the same redaction / ring / subscriber
 * pipeline as every other component.
 */
export function createConsentLogger(options: { enabled?: boolean } = {}): ConsentLogger {
  if (options.enabled === false) {
    return noopLogger;
  }
  return wrap(childFor(getRootLogger(), "consent"));
}
