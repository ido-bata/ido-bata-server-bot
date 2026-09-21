import { Writable } from "node:stream";
import type pinoType from "pino";
import pino from "pino";
import split2 from "split2";

import { RING_MAX, RING_MIN, type RingLogEvent } from "./ring-buffer.js";

export type { RingLogEvent } from "./ring-buffer.js";
export { LogRingBuffer, RING_MAX, RING_MIN } from "./ring-buffer.js";
export type Logger = pinoType.Logger;
export type { pinoType };

/**
 * A normalized log record that has been parsed off the pino stream and is
 * ready for ring buffer / subscriber dispatch. The `receivedAt` field is
 * attached at the sink boundary so consumers can distinguish `time` (the
 * moment pino emitted, may be cached for transport) from `receivedAt` (the
 * moment the structured-logger actually saw it).
 */
export type NormalizedLogEvent = RingLogEvent & {
  receivedAt: number;
};

const subscribers = new Set<(rec: NormalizedLogEvent) => void>();
const ring: NormalizedLogEvent[] = [];

const parser = split2((line: string) => JSON.parse(line) as NormalizedLogEvent);
// `parser` fans out to two destinations: the structured-event sink
// (ring buffer + subscribers) AND, when the composition root opted in to
// stdout output, a tiny Writable that re-emits each parsed record as a
// JSON Line. Doing the tee after the split (rather than as a pino
// multistream) keeps a single parse/normalize path so the `receivedAt`
// stamp is added exactly once.
const stdoutTee = new Writable({
  objectMode: true,
  write(rec: NormalizedLogEvent, _enc, cb) {
    process.stdout.write(`${JSON.stringify(rec)}\n`);
    cb();
  },
});
let stdoutTeePiped = false;

function pipeStdoutTee(): void {
  if (stdoutTeePiped) return;
  stdoutTeePiped = true;
  parser.pipe(stdoutTee);
}

const sink = new Writable({
  objectMode: true,
  write(rec: NormalizedLogEvent, _enc, cb) {
    rec.receivedAt = Date.now();
    ring.push(rec);
    while (ring.length > maxRing) ring.shift();
    for (const fn of subscribers) {
      try {
        fn(rec);
      } catch {
        // subscriber failures must never affect downstream subscribers or
        // the logger itself — swallow and continue.
      }
    }
    cb();
  },
});
parser.pipe(sink);

let maxRing = 200;
let rootLogger: pinoType.Logger | null = null;

export type CreateRootLoggerEnv = NodeJS.ProcessEnv;

export type CreateRootLoggerOptions = {
  /**
   * When `true` (default), log records are also written to
   * `process.stdout` as JSON Lines. Set to `false` when an Ink TUI is
   * mounting on stdout — the TUI owns the terminal and any JSON Lines
   * from pino would corrupt the dashboard render. In Docker / headless
   * mode leave this `true` so `docker compose logs -f bot` shows real
   * JSON Lines.
   */
  writeToStdout?: boolean;
};

/**
 * Enable stdout tee after the logger has been built. Used by the
 * composition root when the TUI is confirmed off and operators want
 * `docker compose logs` to show JSON Lines.
 */
export function enableStdoutTee(): void {
  pipeStdoutTee();
}

export function createRootLogger(
  env: CreateRootLoggerEnv,
  options: CreateRootLoggerOptions = {},
): pinoType.Logger {
  const level = ((env.LOG_LEVEL as pinoType.LevelWithSilent | undefined) ??
    "info") as pinoType.LevelWithSilent;
  maxRing = env.LOG_RING_SIZE ? Math.max(10, Math.min(10_000, Number(env.LOG_RING_SIZE))) : 200;
  const writeToStdout = options.writeToStdout ?? true;
  if (writeToStdout) {
    pipeStdoutTee();
  }
  const logger = pino(
    {
      level,
      base: { service: "ido-bata-server-bot", pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
      messageKey: "message",
      serializers: { err: pino.stdSerializers.err },
      redact: {
        paths: [
          // direct top-level fields
          "discordToken",
          "token",
          "password",
          // nested under arbitrary parents (e.g. config, env, headers)
          "*.discordToken",
          "*.token",
          "*.password",
          // specific known nested path
          "config.discordToken",
        ],
        remove: true,
      },
    },
    parser as unknown as NodeJS.WritableStream,
  );
  rootLogger = logger;
  return logger;
}

export function getRootLogger(): pinoType.Logger {
  if (!rootLogger) {
    // bootstrap fallback for any caller that runs before the composition
    // root wires `createRootLogger`. pino without options writes one JSON
    // line per call directly to stdout — this is the SINGLE allowed
    // console-style fallback for the pre-init path and is overwritten by
    // `createRootLogger` as soon as the composition root runs.
    rootLogger = pino({ level: "info" });
  }
  return rootLogger;
}

export function childFor(logger: pinoType.Logger, feature: string): pinoType.Logger {
  return logger.child({ component: feature });
}

export function subscribe(fn: (rec: NormalizedLogEvent) => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export function snapshotRing(): readonly NormalizedLogEvent[] {
  return ring.slice();
}

export function setRingSize(n: number): void {
  const bounded = Math.max(RING_MIN, Math.min(RING_MAX, n));
  maxRing = bounded;
  while (ring.length > maxRing) ring.shift();
}

/**
 * Returns true when stdout / stdin are TTYs and we are not running in a CI
 * shell or a `TERM=dumb` environment. Used by log sinks to decide between
 * JSON Lines output and a human-readable renderer (e.g. pino-pretty).
 */
export function isInteractive(): boolean {
  return (
    Boolean(process.stdout.isTTY) &&
    Boolean(process.stdin.isTTY) &&
    process.env.TERM !== "dumb" &&
    !process.env.CI
  );
}
