import type { Client } from "discord.js";

import {
  type CancelSessionResult,
  cancelActiveSession,
  clearPendingSchedule,
} from "../timekeeper/service.js";

export type ShutdownSignal = "SIGINT" | "SIGTERM";

export type ShutdownClient = Pick<Client, "destroy">;

export type ShutdownDependencies = {
  cancelActiveSession?: (reason: "cancelled" | "interrupted") => CancelSessionResult;
  clearPendingSchedule?: () => boolean;
  exit?: (code: number) => void;
  flushHistory?: () => void;
  log?: (level: "info" | "warn" | "error", message: string, detail?: unknown) => void;
  processRef?: NodeJS.Process;
};

export type ShutdownController = {
  /** Remove the process signal listeners. Used by tests. */
  dispose: () => void;
  /** Has the controller already triggered a shutdown? */
  isShuttingDown: () => boolean;
  /** Manually trigger a shutdown, e.g. from a test, with the given signal label. */
  trigger: (signal: ShutdownSignal) => Promise<void>;
};

const defaultLog = (level: "info" | "warn" | "error", message: string, detail?: unknown): void => {
  const prefix = `[shutdown] ${message}`;
  if (level === "error") {
    console.error(prefix, detail ?? "");
    return;
  }
  if (level === "warn") {
    console.warn(prefix, detail ?? "");
    return;
  }
  console.log(prefix, detail ?? "");
};

/**
 * Wire SIGINT/SIGTERM into a single graceful-shutdown pipeline. The order of
 * teardown matters:
 *
 *   1. cancel any pending timekeeper schedule timer (no new sessions start)
 *   2. mark the active session as `interrupted`, flush attendance, destroy voice
 *   3. destroy the Discord client (releases the websocket)
 *   4. exit 0
 *
 * Duplicate signals are ignored once a shutdown is in flight.
 */
export function createShutdownController(
  client: ShutdownClient,
  dependencies: ShutdownDependencies = {},
): ShutdownController {
  const processRef = dependencies.processRef ?? process;
  const log = dependencies.log ?? defaultLog;
  const exit = dependencies.exit ?? ((code: number) => processRef.exit(code));
  const cancelFn = dependencies.cancelActiveSession ?? ((reason) => cancelActiveSession(reason));
  const clearSchedule = dependencies.clearPendingSchedule ?? clearPendingSchedule;

  let shuttingDown = false;

  const handleSignal = (signal: ShutdownSignal): void => {
    void trigger(signal);
  };

  const trigger = async (signal: ShutdownSignal): Promise<void> => {
    if (shuttingDown) {
      log("info", `Ignoring duplicate ${signal} — shutdown already in progress`);
      return;
    }
    shuttingDown = true;
    log("info", `Received ${signal}, starting graceful shutdown`);

    const cleared = clearSchedule();
    if (cleared) {
      log("info", "Cleared pending timekeeper schedule timer");
    }

    try {
      const result = cancelFn("interrupted");
      if (result.persisted) {
        log("info", `Cancelled active timekeeper session ${result.sessionId}`);
      } else {
        log("info", "No active timekeeper session to cancel");
      }
    } catch (error) {
      log("error", "Failed to cancel timekeeper session", error);
    }

    dependencies.flushHistory?.();

    try {
      await client.destroy();
      log("info", "Discord client destroyed");
    } catch (error) {
      log("error", "Failed to destroy Discord client", error);
    }

    log("info", "Exiting process");
    exit(0);
  };

  processRef.once("SIGINT", () => handleSignal("SIGINT"));
  processRef.once("SIGTERM", () => handleSignal("SIGTERM"));

  return {
    dispose: () => {
      processRef.removeAllListeners("SIGINT");
      processRef.removeAllListeners("SIGTERM");
    },
    isShuttingDown: () => shuttingDown,
    trigger,
  };
}

export function registerShutdownHandler(client: ShutdownClient): ShutdownController {
  return createShutdownController(client);
}
