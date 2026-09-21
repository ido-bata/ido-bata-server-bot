import { pino, type Logger as PinoLogger } from "pino";

/**
 * Minimal local pino logger used by the consent module.
 *
 * NOTE: This is a *temporary stand-in* for the project-wide logger that
 * is being introduced in #8 (`src/lib/logger`). Once #8 lands, replace
 * this file's usages with `childFor(getRootLogger(), "consent")` and
 * delete `src/consent/logger.ts`.
 */
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

function wrap(pinoInstance: PinoLogger): ConsentLogger {
  return {
    info: (...args: unknown[]) => {
      // Pino expects an object + message OR a single string. The other
      // log callsites pass structured metadata so we forward a flat array.
      pinoInstance.info(flattenArgs(args));
    },
    warn: (...args: unknown[]) => {
      pinoInstance.warn(flattenArgs(args));
    },
    error: (...args: unknown[]) => {
      pinoInstance.error(flattenArgs(args));
    },
    debug: (...args: unknown[]) => {
      pinoInstance.debug(flattenArgs(args));
    },
    child: (bindings: Record<string, unknown>) => wrap(pinoInstance.child(bindings)),
  };
}

function flattenArgs(args: unknown[]): Record<string, unknown> {
  if (args.length === 0) {
    return {};
  }
  if (args.length === 1) {
    return { msg: stringify(args[0]) };
  }
  return { msg: stringify(args[0]), extra: args.slice(1) };
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
 */
export function createConsentLogger(options: { enabled?: boolean } = {}): ConsentLogger {
  if (options.enabled === false) {
    return noopLogger;
  }
  const instance = pino({
    name: "consent",
    level: process.env.LOG_LEVEL ?? "info",
  });
  return wrap(instance);
}