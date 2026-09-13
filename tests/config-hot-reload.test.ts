import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  ConfigStore,
  type ConfigStoreLogger,
  type FileWatcher,
  type FileWatcherFactory,
  type TimerFactory,
  type TimerHandle,
} from "../src/features/config-hot-reload/index.js";
import type { HotReloadConfig } from "../src/features/config-hot-reload/index.js";

class FakeTimers {
  private readonly pending: Array<{
    id: number;
    fire: number;
    callback: () => void;
    handle: TimerHandle;
  }> = [];
  private now = 0;
  private nextId = 1;

  advance(ms: number): void {
    this.now += ms;
    const fireable = this.pending.filter((t) => t.fire <= this.now);
    for (const task of fireable) {
      this.pending.splice(this.pending.indexOf(task), 1);
      task.callback();
    }
  }

  pendingCount(): number {
    return this.pending.length;
  }

  asTimerFactory(): TimerFactory {
    const pending = this.pending;
    const now = this.now;
    let nextId = this.nextId;
    return {
      schedule: (callback: () => void, delayMs: number) => {
        const id = nextId++;
        const handle: TimerHandle = {
          clear: () => {
            const idx = pending.findIndex((t) => t.id === id);
            if (idx >= 0) {
              pending.splice(idx, 1);
            }
          },
        };
        pending.push({
          id,
          fire: now + delayMs,
          callback,
          handle,
        });
        return handle;
      },
    };
  }
}

function makeFakeWatcher(): {
  factory: FileWatcherFactory;
  fire: () => void;
  closeCount: () => number;
} {
  let closeCount = 0;
  let onChange: (() => void) | null = null;
  const factory: FileWatcherFactory = (_filePath: string, cb: () => void) => {
    onChange = cb;
    const watcher: FileWatcher = {
      close: () => {
        closeCount += 1;
        onChange = null;
      },
    };
    return watcher;
  };
  return {
    factory,
    fire: () => {
      if (!onChange) {
        throw new Error("watcher is not active");
      }
      onChange();
    },
    closeCount: () => closeCount,
  };
}

function makeLogger(): ConfigStoreLogger & {
  info: Mock;
  warn: Mock;
  error: Mock;
} {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("ConfigStore", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "config-hot-reload-"));
    filePath = join(dir, "config.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads the initial config from disk and exposes it via get()", async () => {
    writeFileSync(
      filePath,
      JSON.stringify({ announcementChannelId: "111111111111111111" }, null, 2),
    );

    const timers = new FakeTimers();
    const watcher = makeFakeWatcher();
    const logger = makeLogger();

    const store = new ConfigStore({
      filePath,
      debounceMs: 100,
      logger,
      watcherFactory: watcher.factory,
      timerFactory: timers.asTimerFactory(),
    });

    await store.start();

    expect(store.get()).toEqual({ announcementChannelId: "111111111111111111" });
    expect(logger.info).toHaveBeenCalledWith(
      "loaded initial config",
      expect.objectContaining({ filePath }),
    );

    store.stop();
  });

  it("merges partial updates over the existing snapshot", async () => {
    writeFileSync(
      filePath,
      JSON.stringify(
        {
          announcementChannelId: "111111111111111111",
          auditLogChannelId: "222222222222222222",
        },
        null,
        2,
      ),
    );

    const timers = new FakeTimers();
    const watcher = makeFakeWatcher();
    const store = new ConfigStore({
      filePath,
      debounceMs: 100,
      logger: makeLogger(),
      watcherFactory: watcher.factory,
      timerFactory: timers.asTimerFactory(),
    });
    await store.start();

    // Replace the file with only one key — the other must survive.
    writeFileSync(filePath, JSON.stringify({ auditLogChannelId: "333333333333333333" }));
    watcher.fire();
    await timers.advance(200);
    await store.whenIdle();

    expect(store.get()).toEqual({
      announcementChannelId: "111111111111111111",
      auditLogChannelId: "333333333333333333",
    });

    store.stop();
  });

  it("debounces rapid watcher events into a single apply", async () => {
    writeFileSync(filePath, JSON.stringify({ announcementChannelId: "111111111111111111" }));

    const timers = new FakeTimers();
    const watcher = makeFakeWatcher();
    const logger = makeLogger();
    const store = new ConfigStore({
      filePath,
      debounceMs: 500,
      logger,
      watcherFactory: watcher.factory,
      timerFactory: timers.asTimerFactory(),
    });
    await store.start();

    writeFileSync(filePath, JSON.stringify({ announcementChannelId: "444444444444444444" }));
    watcher.fire();

    // Editor often fires 2-3 events per save — simulate.
    timers.advance(100);
    writeFileSync(filePath, JSON.stringify({ announcementChannelId: "555555555555555555" }));
    watcher.fire();
    timers.advance(100);
    writeFileSync(filePath, JSON.stringify({ announcementChannelId: "666666666666666666" }));
    watcher.fire();

    expect(timers.pendingCount()).toBe(1);

    await timers.advance(600);
    await store.whenIdle();

    expect(store.get()).toEqual({ announcementChannelId: "666666666666666666" });
    expect(logger.info).toHaveBeenCalledWith(
      "applied hot-reloaded config",
      expect.objectContaining({ filePath }),
    );

    store.stop();
  });

  it("keeps the previous config when the new file fails schema validation", async () => {
    writeFileSync(filePath, JSON.stringify({ announcementChannelId: "111111111111111111" }));

    const timers = new FakeTimers();
    const watcher = makeFakeWatcher();
    const logger = makeLogger();
    const store = new ConfigStore({
      filePath,
      debounceMs: 100,
      logger,
      watcherFactory: watcher.factory,
      timerFactory: timers.asTimerFactory(),
    });
    await store.start();

    // Bad payload: announcementChannelId is not a snowflake, plus an unknown key.
    writeFileSync(
      filePath,
      JSON.stringify({ announcementChannelId: "not-a-snowflake", mystery: true }),
    );
    watcher.fire();
    await timers.advance(200);
    await store.whenIdle();

    expect(store.get()).toEqual({ announcementChannelId: "111111111111111111" });
    expect(logger.error).toHaveBeenCalledWith(
      "rejected config change; keeping previous snapshot",
      expect.objectContaining({ filePath }),
    );
    store.stop();
  });

  it("keeps the previous config when the file contains invalid JSON", async () => {
    writeFileSync(filePath, JSON.stringify({ announcementChannelId: "111111111111111111" }));

    const timers = new FakeTimers();
    const watcher = makeFakeWatcher();
    const logger = makeLogger();
    const store = new ConfigStore({
      filePath,
      debounceMs: 100,
      logger,
      watcherFactory: watcher.factory,
      timerFactory: timers.asTimerFactory(),
    });
    await store.start();

    writeFileSync(filePath, "{ not valid json");
    watcher.fire();
    await timers.advance(200);
    await store.whenIdle();

    expect(store.get()).toEqual({ announcementChannelId: "111111111111111111" });
    expect(logger.error).toHaveBeenCalledWith(
      "rejected config change; keeping previous snapshot",
      expect.objectContaining({ filePath, error: expect.stringContaining("invalid JSON") }),
    );
    store.stop();
  });

  it("invokes update listeners with previous and new snapshots", async () => {
    writeFileSync(filePath, JSON.stringify({ announcementChannelId: "111111111111111111" }));

    const timers = new FakeTimers();
    const watcher = makeFakeWatcher();
    const store = new ConfigStore({
      filePath,
      debounceMs: 100,
      logger: makeLogger(),
      watcherFactory: watcher.factory,
      timerFactory: timers.asTimerFactory(),
    });
    await store.start();

    const updates: Array<{ previous: HotReloadConfig; next: HotReloadConfig }> = [];
    store.onUpdate((next, previous) => {
      updates.push({ previous, next });
    });

    writeFileSync(filePath, JSON.stringify({ announcementChannelId: "777777777777777777" }));
    watcher.fire();
    await timers.advance(200);
    await store.whenIdle();

    expect(updates).toEqual([
      {
        previous: { announcementChannelId: "111111111111111111" },
        next: { announcementChannelId: "777777777777777777" },
      },
    ]);
    store.stop();
  });

  it("invokes error listeners when validation fails", async () => {
    writeFileSync(filePath, JSON.stringify({ announcementChannelId: "111111111111111111" }));

    const timers = new FakeTimers();
    const watcher = makeFakeWatcher();
    const store = new ConfigStore({
      filePath,
      debounceMs: 100,
      logger: makeLogger(),
      watcherFactory: watcher.factory,
      timerFactory: timers.asTimerFactory(),
    });
    await store.start();

    const errors: Error[] = [];
    store.onError((err) => {
      errors.push(err);
    });

    writeFileSync(filePath, "{ not valid json");
    watcher.fire();
    await timers.advance(200);
    await store.whenIdle();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("invalid JSON");
    store.stop();
  });

  it("falls back to an empty config when the file is missing on startup", async () => {
    const timers = new FakeTimers();
    const watcher = makeFakeWatcher();
    const logger = makeLogger();
    const store = new ConfigStore({
      filePath,
      debounceMs: 100,
      logger,
      watcherFactory: watcher.factory,
      timerFactory: timers.asTimerFactory(),
    });

    await store.start();

    expect(store.get()).toEqual({});
    expect(logger.warn).toHaveBeenCalledWith(
      "config file missing at startup; starting with empty config",
      expect.objectContaining({ filePath }),
    );
    store.stop();
  });

  it("stop() closes the watcher and clears pending timers", async () => {
    writeFileSync(filePath, JSON.stringify({ announcementChannelId: "111111111111111111" }));

    const timers = new FakeTimers();
    const watcher = makeFakeWatcher();
    const store = new ConfigStore({
      filePath,
      debounceMs: 500,
      logger: makeLogger(),
      watcherFactory: watcher.factory,
      timerFactory: timers.asTimerFactory(),
    });
    await store.start();

    writeFileSync(filePath, JSON.stringify({ announcementChannelId: "888888888888888888" }));
    watcher.fire();
    expect(timers.pendingCount()).toBe(1);

    store.stop();

    expect(timers.pendingCount()).toBe(0);
    expect(watcher.closeCount()).toBe(1);

    // Late events should not resurrect state.
    await timers.advance(1000);
    await store.whenIdle();
    expect(store.get()).toEqual({ announcementChannelId: "111111111111111111" });
  });
});
