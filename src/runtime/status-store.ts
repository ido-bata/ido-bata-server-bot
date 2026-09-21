/**
 * RuntimeStatusStore — a small, synchronous, in-memory read model that the
 * TUI (and future subscribers like a JSON snapshot endpoint) can read
 * from without reaching into Discord client state, feature services, or
 * process globals.
 *
 * Design rules:
 *
 * - The store owns its current snapshot. Subscribers receive a *new*
 *   frozen object on every change — never the internal mutable reference.
 * - `events` is a bounded FIFO ring buffer capped at `eventsCap`. When
 *   the cap shrinks, oldest entries are dropped.
 * - Listener errors are caught and swallowed: a buggy consumer must
 *   never affect downstream consumers or the store itself.
 * - No Discord tokens, message content, or PII is ever placed in the
 *   snapshot by design — see `src/runtime/snapshots.ts`.
 */

import type { NormalizedLogEvent } from "../lib/logger/index.js";
import type { FeaturesSnapshot, RuntimeStatusPatch, RuntimeStatusSnapshot } from "./snapshots.js";

export const EVENTS_CAP_MIN = 10;
export const EVENTS_CAP_MAX = 10_000;
export const EVENTS_CAP_DEFAULT = 200;

export type RuntimeStatusListener = (snapshot: RuntimeStatusSnapshot) => void;

export interface RuntimeStatusStore {
  /** Current snapshot (a fresh frozen object on each access). */
  readonly snapshot: RuntimeStatusSnapshot;
  /** Subscribe to changes. Returns an unsubscribe function. */
  subscribe(listener: RuntimeStatusListener): () => void;
  /**
   * Apply a partial patch to the snapshot. `events` is intentionally
   * excluded — append through `appendEvent` instead so the ring buffer
   * invariant is preserved.
   */
  set(patch: RuntimeStatusPatch): void;
  /** Append a logger event to the bounded ring buffer. */
  appendEvent(event: NormalizedLogEvent): void;
  /** Replace the ring buffer cap. Clamped to `[EVENTS_CAP_MIN, EVENTS_CAP_MAX]`. */
  setEventsCap(cap: number): void;
  /** Detach every subscriber. Used by the TUI during shutdown. */
  clearListeners(): void;
}

/**
 * Build the initial empty feature map. We seed every known feature with
 * `disabled` so the panel has a row to render before composition root
 * wires real state. Real state is then applied via `store.set` once the
 * feature has decided whether it is enabled.
 */
function initialFeatures(): FeaturesSnapshot {
  const keys = [
    "consent",
    "timekeeper",
    "slash-commands",
    "ical-calendar",
    "github-webhook",
    "health-metrics",
    "error-forwarder",
    "multi-guild",
  ] as const;
  const out: Record<string, { state: "enabled" | "disabled" | "degraded"; meta?: unknown }> = {};
  for (const key of keys) {
    out[key] = { state: "disabled" };
  }
  return out as unknown as FeaturesSnapshot;
}

function freeze<T>(value: T): T {
  // Top-level freeze prevents replacing slice fields on the snapshot.
  // Inner slices are themselves plain objects; we also freeze them so
  // the typical "subscriber attempts to mutate a received snapshot"
  // failure mode (strict-mode TypeError) is caught at runtime.
  // NOTE: arrays are intentionally NOT frozen because the events ring
  // buffer is mutated in-place; subscribers receive frozen *copies* of
  // the array via the snapshot, so they cannot splice the live buffer.
  if (value === null || typeof value !== "object") {
    return value;
  }
  for (const key of Object.keys(value)) {
    const inner = (value as Record<string, unknown>)[key];
    if (inner === null || typeof inner !== "object") {
      continue;
    }
    if (Array.isArray(inner)) {
      continue;
    }
    Object.freeze(inner);
  }
  return Object.freeze(value);
}

/**
 * Create a fresh store. Defaults are conservative; the composition root
 * replaces slices as feature registrations succeed/fail.
 */
export function createRuntimeStatusStore(
  initial: Partial<RuntimeStatusSnapshot> = {},
): RuntimeStatusStore {
  let eventsCap = clampEventsCap(EVENTS_CAP_DEFAULT);
  const events: NormalizedLogEvent[] = [];
  const listeners = new Set<RuntimeStatusListener>();

  let current: RuntimeStatusSnapshot = freeze({
    app: {
      name: "ido-bata-server-bot",
      version: "0.0.0",
      mode: process.stdout.isTTY ? "tty" : "headless",
      uptimeMs: 0,
      capturedAt: Date.now(),
    },
    discord: {
      state: "connecting",
      user: null,
      guildCount: 0,
      pingMs: null,
    },
    features: initialFeatures(),
    consent: {
      policyVersion: "unknown",
      activeGrants: 0,
      aggregateByScope: {
        "activity-history": 0,
        "presence-history": 0,
        profile: 0,
        "message-history": 0,
      },
    },
    timekeeper: {
      state: "idle",
      nextSessionAt: null,
      activePhase: null,
    },
    runtime: {
      pid: process.pid,
      node: process.version,
      rssBytes: process.memoryUsage().rss,
      httpEndpoints: [],
    },
    events,
    ...initial,
  });

  function notify(snapshot: RuntimeStatusSnapshot): void {
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // Subscriber failures must never affect downstream subscribers
        // or the store itself — swallow and continue.
      }
    }
  }

  function replace(next: RuntimeStatusSnapshot): void {
    current = freeze(next);
    notify(current);
  }

  return {
    get snapshot(): RuntimeStatusSnapshot {
      // Always return a frozen reference; subscribers should treat this
      // as immutable. We do not deep-copy for performance: callers that
      // mutate will trigger a `setFrozen` TypeError at the next access.
      return current;
    },

    subscribe(listener: RuntimeStatusListener): () => void {
      listeners.add(listener);
      // Fire immediately so subscribers can render with current state
      // before the first change event arrives.
      try {
        listener(current);
      } catch {
        // Initial-fire failure must not affect subsequent events.
      }
      return () => {
        listeners.delete(listener);
      };
    },

    set(patch: RuntimeStatusPatch): void {
      const next: RuntimeStatusSnapshot = freeze({
        ...current,
        ...patch,
      });
      replace(next);
    },

    appendEvent(event: NormalizedLogEvent): void {
      // We hold a private array of frozen entries; replace the slot on
      // every change so subscribers can rely on referential equality.
      // Mutate the internal array so subsequent reads see the new entry.
      events.push(event);
      while (events.length > eventsCap) {
        events.shift();
      }
      // Replace `events` in the next snapshot with a frozen copy of the
      // current internal state.
      const snapshot: RuntimeStatusSnapshot = freeze({
        ...current,
        events: Object.freeze(events.slice()),
      });
      current = snapshot;
      notify(snapshot);
    },

    setEventsCap(cap: number): void {
      const next = clampEventsCap(cap);
      eventsCap = next;
      if (events.length > next) {
        const trimmed = events.slice(events.length - next);
        events.length = 0;
        events.push(...trimmed);
      }
      // Replace snapshot so the (unchanged) events array reference is
      // also reflected; this keeps `snapshot.events` consistent with the
      // internal `events` reference.
      const snapshot: RuntimeStatusSnapshot = freeze({
        ...current,
        events: Object.freeze(events.slice()),
      });
      current = snapshot;
      notify(snapshot);
    },

    clearListeners(): void {
      listeners.clear();
    },
  };
}

function clampEventsCap(cap: number): number {
  if (!Number.isFinite(cap)) {
    return EVENTS_CAP_DEFAULT;
  }
  const rounded = Math.floor(cap);
  if (rounded < EVENTS_CAP_MIN) {
    return EVENTS_CAP_MIN;
  }
  if (rounded > EVENTS_CAP_MAX) {
    return EVENTS_CAP_MAX;
  }
  return rounded;
}
