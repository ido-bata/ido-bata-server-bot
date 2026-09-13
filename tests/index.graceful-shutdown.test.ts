import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";
import type { ShutdownSignal } from "../src/features/shutdown/handler.js";
import { createShutdownController } from "../src/features/shutdown/handler.js";
import type { CancelSessionResult } from "../src/features/timekeeper/service.js";

type FakeProcess = NodeJS.Process & {
  emit: (event: string, ...args: unknown[]) => boolean;
};

function createFakeProcess(): FakeProcess {
  const emitter = new EventEmitter();
  const fake = {
    ...process,
    addListener: emitter.addListener.bind(emitter),
    emit: emitter.emit.bind(emitter),
    eventNames: emitter.eventNames.bind(emitter),
    listeners: emitter.listeners.bind(emitter),
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
    prependListener: emitter.prependListener.bind(emitter),
    prependOnceListener: emitter.prependOnceListener.bind(emitter),
    removeAllListeners: emitter.removeAllListeners.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    setMaxListeners: emitter.setMaxListeners.bind(emitter),
    rawListeners: emitter.rawListeners.bind(emitter),
  } as unknown as FakeProcess;
  return fake;
}

describe("graceful shutdown controller", () => {
  it("cancels the active timekeeper session and destroys the client on SIGINT", async () => {
    const cancelActiveSession = vi.fn(
      (): CancelSessionResult => ({
        persisted: true,
        reason: "interrupted",
        sessionId: "session-1",
      }),
    );
    const clearPendingSchedule = vi.fn(() => true);
    const destroy = vi.fn(async () => undefined);
    const exit = vi.fn();
    const flushHistory = vi.fn();
    const processRef = createFakeProcess();
    const log = vi.fn();

    const controller = createShutdownController(
      { destroy },
      {
        cancelActiveSession,
        clearPendingSchedule,
        exit,
        flushHistory,
        log,
        processRef,
      },
    );

    await controller.trigger("SIGINT");

    expect(clearPendingSchedule).toHaveBeenCalledTimes(1);
    expect(cancelActiveSession).toHaveBeenCalledWith("interrupted");
    expect(flushHistory).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(controller.isShuttingDown()).toBe(true);
  });

  it("treats SIGTERM the same as SIGINT", async () => {
    const cancelActiveSession = vi.fn(
      (): CancelSessionResult => ({ persisted: false, reason: "interrupted", sessionId: null }),
    );
    const clearPendingSchedule = vi.fn(() => false);
    const destroy = vi.fn(async () => undefined);
    const exit = vi.fn();
    const processRef = createFakeProcess();

    const controller = createShutdownController(
      { destroy },
      {
        cancelActiveSession,
        clearPendingSchedule,
        exit,
        processRef,
      },
    );

    await controller.trigger("SIGTERM");

    expect(cancelActiveSession).toHaveBeenCalledWith("interrupted");
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("ignores duplicate signals while shutdown is already in progress", async () => {
    const cancelActiveSession = vi.fn(
      (): CancelSessionResult => ({
        persisted: true,
        reason: "interrupted",
        sessionId: "session-1",
      }),
    );
    const clearPendingSchedule = vi.fn(() => true);
    const destroy = vi.fn(async () => undefined);
    const exit = vi.fn();
    const processRef = createFakeProcess();

    const controller = createShutdownController(
      { destroy },
      {
        cancelActiveSession,
        clearPendingSchedule,
        exit,
        processRef,
      },
    );

    await Promise.all([controller.trigger("SIGINT"), controller.trigger("SIGTERM")]);

    expect(cancelActiveSession).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("registers SIGINT and SIGTERM listeners on the process", () => {
    const cancelActiveSession = vi.fn(
      (): CancelSessionResult => ({ persisted: false, reason: "interrupted", sessionId: null }),
    );
    const clearPendingSchedule = vi.fn(() => false);
    const destroy = vi.fn(async () => undefined);
    const exit = vi.fn();
    const processRef = createFakeProcess();
    const onSpy = vi.spyOn(processRef, "on");

    createShutdownController(
      { destroy },
      {
        cancelActiveSession,
        clearPendingSchedule,
        exit,
        processRef,
      },
    );

    expect(processRef.eventNames()).toEqual(expect.arrayContaining(["SIGINT", "SIGTERM"]));
    expect(onSpy).not.toHaveBeenCalled();
  });

  it("invokes the cancellation pipeline when a real signal is emitted", async () => {
    const cancelActiveSession = vi.fn(
      (): CancelSessionResult => ({
        persisted: true,
        reason: "interrupted",
        sessionId: "session-1",
      }),
    );
    const clearPendingSchedule = vi.fn(() => true);
    const destroy = vi.fn(async () => undefined);
    const exit = vi.fn();
    const processRef = createFakeProcess();

    const controller = createShutdownController(
      { destroy },
      {
        cancelActiveSession,
        clearPendingSchedule,
        exit,
        processRef,
      },
    );

    const signal: ShutdownSignal = "SIGINT";
    processRef.emit(signal);

    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    expect(clearPendingSchedule).toHaveBeenCalledTimes(1);
    expect(cancelActiveSession).toHaveBeenCalledWith("interrupted");
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);

    controller.dispose();
  });

  it("still destroys the client and exits when cancel throws", async () => {
    const cancelActiveSession = vi.fn(() => {
      throw new Error("boom");
    });
    const clearPendingSchedule = vi.fn(() => true);
    const destroy = vi.fn(async () => undefined);
    const exit = vi.fn();
    const log = vi.fn();
    const processRef = createFakeProcess();

    const controller = createShutdownController(
      { destroy },
      {
        cancelActiveSession,
        clearPendingSchedule,
        exit,
        log,
        processRef,
      },
    );

    await controller.trigger("SIGTERM");

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(log).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("Failed to cancel"),
      expect.any(Error),
    );
  });

  it("still exits when client.destroy throws", async () => {
    const cancelActiveSession = vi.fn(
      (): CancelSessionResult => ({ persisted: false, reason: "interrupted", sessionId: null }),
    );
    const clearPendingSchedule = vi.fn(() => false);
    const destroy = vi.fn(async () => {
      throw new Error("ws down");
    });
    const exit = vi.fn();
    const processRef = createFakeProcess();

    const controller = createShutdownController(
      { destroy },
      {
        cancelActiveSession,
        clearPendingSchedule,
        exit,
        processRef,
      },
    );

    await controller.trigger("SIGTERM");

    expect(exit).toHaveBeenCalledWith(0);
  });

  it("removes listeners on dispose", () => {
    const cancelActiveSession = vi.fn(
      (): CancelSessionResult => ({ persisted: false, reason: "interrupted", sessionId: null }),
    );
    const clearPendingSchedule = vi.fn(() => false);
    const destroy = vi.fn(async () => undefined);
    const exit = vi.fn();
    const processRef = createFakeProcess();

    const controller = createShutdownController(
      { destroy },
      {
        cancelActiveSession,
        clearPendingSchedule,
        exit,
        processRef,
      },
    );

    expect(processRef.eventNames()).toEqual(expect.arrayContaining(["SIGINT", "SIGTERM"]));
    controller.dispose();
    expect(processRef.eventNames()).not.toEqual(expect.arrayContaining(["SIGINT", "SIGTERM"]));
  });
});
