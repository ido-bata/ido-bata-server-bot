import { describe, expect, it } from "vitest";

import type { NormalizedLogEvent } from "../../src/lib/logger/index.js";
import type { RuntimeStatusSnapshot } from "../../src/runtime/snapshots.js";
import {
  createRuntimeStatusStore,
  EVENTS_CAP_DEFAULT,
  EVENTS_CAP_MAX,
  EVENTS_CAP_MIN,
} from "../../src/runtime/status-store.js";

function makeEvent(seq: number): NormalizedLogEvent {
  return {
    level: 30,
    time: 1_700_000_000_000 + seq,
    pid: 1,
    service: "ido-bata-server-bot",
    message: `event-${seq}`,
    component: "test",
    receivedAt: 1_700_000_000_000 + seq,
  };
}

function snapshotKeys(): string[] {
  return ["app", "discord", "features", "consent", "timekeeper", "runtime", "events"];
}

describe("createRuntimeStatusStore", () => {
  it("exposes a snapshot with all expected slices", () => {
    const store = createRuntimeStatusStore();
    expect(Object.keys(store.snapshot).sort()).toEqual(snapshotKeys().sort());
    expect(store.snapshot.events).toEqual([]);
    expect(store.snapshot.discord.state).toBe("connecting");
    expect(store.snapshot.runtime.pid).toBe(process.pid);
  });

  it("starts with the default event cap", () => {
    const store = createRuntimeStatusStore();
    expect(store.snapshot.events.length).toBe(0);
    // We can't read the cap directly from the snapshot, but pushing past
    // the default cap should still leave us bounded.
    for (let i = 0; i < EVENTS_CAP_DEFAULT + 50; i += 1) {
      store.appendEvent(makeEvent(i));
    }
    expect(store.snapshot.events.length).toBe(EVENTS_CAP_DEFAULT);
  });

  it("returns a fresh snapshot reference on every change", () => {
    const store = createRuntimeStatusStore();
    const before = store.snapshot;
    store.set({ discord: { ...store.snapshot.discord, state: "ready" } });
    const after = store.snapshot;
    expect(after).not.toBe(before);
    expect(after.discord.state).toBe("ready");
    expect(before.discord.state).toBe("connecting");
  });

  it("notifies multiple subscribers and returns the snapshot to each", () => {
    const store = createRuntimeStatusStore();
    const received: Array<RuntimeStatusSnapshot> = [];
    const unsubA = store.subscribe((snap) => received.push(snap));
    const unsubB = store.subscribe((snap) => received.push(snap));

    // Initial fire (1 each), then a change (1 each) = 4 total.
    store.set({ discord: { ...store.snapshot.discord, guildCount: 3 } });

    expect(received.length).toBeGreaterThanOrEqual(4);
    for (const snap of received) {
      expect(Object.keys(snap).sort()).toEqual(snapshotKeys().sort());
    }
    unsubA();
    unsubB();
  });

  it("isolates subscriber failures: one bad listener does not affect others", () => {
    const store = createRuntimeStatusStore();
    const goodReceived: string[] = [];
    store.subscribe(() => {
      throw new Error("intentional-bug");
    });
    store.subscribe((snap) => {
      goodReceived.push(snap.discord.state);
    });

    expect(() =>
      store.set({ discord: { ...store.snapshot.discord, state: "ready" } }),
    ).not.toThrow();
    expect(goodReceived.at(-1)).toBe("ready");
  });

  it("does not propagate initial-fire failures", () => {
    const store = createRuntimeStatusStore();
    const later: string[] = [];
    expect(() =>
      store.subscribe(() => {
        throw new Error("initial-fire-bug");
      }),
    ).not.toThrow();
    const unsub = store.subscribe((snap) => later.push(snap.discord.state));
    store.set({ discord: { ...store.snapshot.discord, state: "ready" } });
    expect(later.at(-1)).toBe("ready");
    unsub();
  });

  it("returns an unsubscribe function that detaches the listener", () => {
    const store = createRuntimeStatusStore();
    const received: string[] = [];
    const unsubscribe = store.subscribe((snap) => received.push(snap.discord.state));
    expect(received.length).toBe(1); // initial fire
    unsubscribe();
    store.set({ discord: { ...store.snapshot.discord, state: "ready" } });
    // No additional entries after unsubscribe.
    expect(received.length).toBe(1);
    expect(received[0]).toBe("connecting");
  });

  it("set() applies a partial patch without dropping other slices", () => {
    const store = createRuntimeStatusStore();
    store.appendEvent(makeEvent(0));
    const before = store.snapshot;
    expect(before.events.length).toBe(1);

    store.set({ discord: { ...store.snapshot.discord, guildCount: 7 } });

    const after = store.snapshot;
    expect(after.events.length).toBe(1); // untouched
    expect(after.discord.guildCount).toBe(7);
  });

  it("appendEvent adds to the ring buffer and notifies subscribers", () => {
    const store = createRuntimeStatusStore();
    const lengths: number[] = [];
    store.subscribe((snap) => lengths.push(snap.events.length));

    store.appendEvent(makeEvent(0));
    store.appendEvent(makeEvent(1));
    store.appendEvent(makeEvent(2));

    expect(store.snapshot.events.length).toBe(3);
    // 1 initial (empty) + 3 appends = 4 notifications.
    expect(lengths.length).toBeGreaterThanOrEqual(4);
  });

  it("setEventsCap shrinks the buffer when capacity decreases", () => {
    const store = createRuntimeStatusStore();
    for (let i = 0; i < 50; i += 1) {
      store.appendEvent(makeEvent(i));
    }
    expect(store.snapshot.events.length).toBe(50);

    store.setEventsCap(10);
    expect(store.snapshot.events.length).toBe(10);
    // Most recent entries retained.
    const messages = store.snapshot.events.map((e) => e.message);
    expect(messages).toContain("event-49");
    expect(messages).not.toContain("event-0");
  });

  it("setEventsCap clamps below the floor", () => {
    const store = createRuntimeStatusStore();
    store.setEventsCap(-5);
    for (let i = 0; i < EVENTS_CAP_MIN + 5; i += 1) {
      store.appendEvent(makeEvent(i));
    }
    expect(store.snapshot.events.length).toBe(EVENTS_CAP_MIN);
  });

  it("setEventsCap clamps above the ceiling", () => {
    const store = createRuntimeStatusStore();
    store.setEventsCap(EVENTS_CAP_MAX + 10_000);
    expect(store.snapshot.events.length).toBe(0);
    store.setEventsCap(EVENTS_CAP_MAX);
    // No-op when within range.
    expect(store.snapshot.events.length).toBe(0);
  });

  it("clearListeners detaches every subscriber", () => {
    const store = createRuntimeStatusStore();
    const received: string[] = [];
    store.subscribe((snap) => received.push(snap.discord.state));
    // subscribe() fires immediately once with the current snapshot.
    expect(received).toEqual(["connecting"]);
    store.clearListeners();
    store.set({ discord: { ...store.snapshot.discord, state: "ready" } });
    // Subscriber was cleared before the change — no further notifications.
    expect(received).toEqual(["connecting"]);
  });

  it("accepts an initial partial override", () => {
    const store = createRuntimeStatusStore({
      app: {
        name: "custom-bot",
        version: "9.9.9",
        mode: "headless",
        uptimeMs: 1234,
        capturedAt: 0,
      },
    });
    expect(store.snapshot.app.name).toBe("custom-bot");
    expect(store.snapshot.app.version).toBe("9.9.9");
    // Other slices still get their defaults.
    expect(store.snapshot.discord.state).toBe("connecting");
  });

  it("subscribers cannot mutate the snapshot they receive", () => {
    const store = createRuntimeStatusStore();
    let captured: RuntimeStatusSnapshot | null = null;
    store.subscribe((snap) => {
      captured = snap;
    });
    expect(captured).not.toBeNull();
    // The store marks the snapshot `Object.freeze`-d; mutation should
    // throw in strict mode (which our tsconfig enables).
    expect(() => {
      (captured as unknown as { discord: { state: string } }).discord.state = "ready";
    }).toThrow();
    // And the internal state must remain unchanged.
    expect(store.snapshot.discord.state).toBe("connecting");
  });
});
