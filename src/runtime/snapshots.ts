/**
 * Read-only snapshot types for the runtime status store. These are
 * re-exported so the TUI and other consumers do not have to reach into
 * feature directories to learn about feature shapes.
 *
 * The snapshot is intentionally narrow: counts, states, IDs — never
 * tokens, never raw message content, never PII. TUI is a monitoring
 * surface, not a debug surface.
 */

import type { NormalizedLogEvent } from "../lib/logger/index.js";

export const CONSENT_SCOPES = [
  "activity-history",
  "presence-history",
  "profile",
  "message-history",
] as const;

export type ConsentScope = (typeof CONSENT_SCOPES)[number];

export type AppSnapshot = {
  name: string;
  version: string;
  /** Whether the process is connected to a real TTY (true) or running headless (false). */
  mode: "tty" | "headless";
  /** Wall-clock uptime of the process in milliseconds. */
  uptimeMs: number;
  /** Wall-clock time the snapshot was computed (ms since epoch). */
  capturedAt: number;
};

export type DiscordState = "connecting" | "ready" | "disconnected";

export type DiscordSnapshot = {
  state: DiscordState;
  /** Optional user tag, e.g. `ido-bata-bot#1234`. May be undefined before ClientReady. */
  user: string | null;
  /** Number of guilds currently in cache. */
  guildCount: number;
  /** Gateway ping in milliseconds; null while disconnected. */
  pingMs: number | null;
};

export type FeatureState = "enabled" | "disabled" | "degraded";

export type FeatureSnapshot = {
  state: FeatureState;
  /** Optional feature-specific metadata — counts, last-seen timestamps, etc. */
  meta?: Readonly<Record<string, unknown>>;
};

export type FeaturesSnapshot = {
  consent: FeatureSnapshot;
  timekeeper: FeatureSnapshot;
  "slash-commands": FeatureSnapshot;
  "ical-calendar": FeatureSnapshot;
  "github-webhook": FeatureSnapshot;
  "health-metrics": FeatureSnapshot;
  "error-forwarder": FeatureSnapshot;
  "multi-guild": FeatureSnapshot;
  [key: string]: FeatureSnapshot;
};

export type ConsentSnapshot = {
  policyVersion: string;
  activeGrants: number;
  /** Aggregate active-grant counts per scope. */
  aggregateByScope: Readonly<Record<ConsentScope, number>>;
};

export type TimekeeperState = "idle" | "scheduled" | "running";

export type TimekeeperSnapshot = {
  state: TimekeeperState;
  /** ISO 8601 string of the next scheduled session start, if any. */
  nextSessionAt: string | null;
  /** Active phase label, only present while running. */
  activePhase: string | null;
};

export type HttpEndpointSnapshot = {
  name: string;
  url: string;
  state: "listening" | "stopped";
};

export type RuntimeSnapshot = {
  pid: number;
  node: string;
  /** Resident set size in bytes. */
  rssBytes: number;
  httpEndpoints: ReadonlyArray<HttpEndpointSnapshot>;
};

/**
 * The full snapshot exposed by `RuntimeStatusStore.snapshot`. Each field
 * is independently updated; the whole object is replaced (immutably) on
 * every change.
 */
export type RuntimeStatusSnapshot = {
  app: AppSnapshot;
  discord: DiscordSnapshot;
  features: FeaturesSnapshot;
  consent: ConsentSnapshot;
  timekeeper: TimekeeperSnapshot;
  runtime: RuntimeSnapshot;
  /** Bounded ring buffer of recent logger events (oldest first). */
  events: ReadonlyArray<NormalizedLogEvent>;
};

/**
 * Patch payload for `RuntimeStatusStore.set` — any subset of slices
 * excluding `events`, which is mutated through `appendEvent`.
 */
export type RuntimeStatusPatch = Partial<
  Pick<RuntimeStatusSnapshot, "app" | "discord" | "features" | "consent" | "timekeeper" | "runtime">
>;
