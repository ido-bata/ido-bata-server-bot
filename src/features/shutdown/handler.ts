import { getVoiceConnections } from "@discordjs/voice";
import type { Client } from "discord.js";

import { cancelActiveSession } from "../timekeeper/service.js";

type ShutdownSignal = "SIGINT" | "SIGTERM";

export type ShutdownDependencies = {
  /**
   * Cancels any in-progress timekeeper session and flushes its state. Defaults
   * to the real implementation exported from the timekeeper feature.
   */
  cancelSession?: () => boolean;
  /**
   * Destroys all Discord voice connections tracked by @discordjs/voice.
   * Defaults to iterating `getVoiceConnections()`.
   */
  destroyVoiceConnections?: () => void;
  /**
   * Destroys the Discord client. Defaults to `client.destroy()`.
   */
  destroyClient?: () => Promise<void>;
  /**
   * Terminates the process. Defaults to `process.exit(0)`.
   */
  exit?: (code: number) => void;
  /**
   * Override the wall-clock for tests.
   */
  now?: () => Date;
  /**
   * Runs after the timekeeper / voice / client teardown chain, but before
   * `exit`. Use this for release-mode-only resources that need explicit
   * teardown (e.g. closing a file watcher). Failures are logged and
   * swallowed so the exit still runs.
   */
  onAfterTeardown?: () => void | Promise<void>;
};

export type ShutdownLogger = (message: string) => void;

export type ShutdownRunner = {
  /** Run the shutdown sequence manually (e.g. from a test or signal). */
  run: (signal: ShutdownSignal) => Promise<void>;
};

/**
 * Wire SIGINT and SIGTERM into a graceful shutdown sequence. The order is:
 *
 *   1. cancel any in-progress timekeeper session (mark + flush state)
 *   2. destroy every active voice connection so the bot is not stuck in
 *      a stage / voice channel after the process exits
 *   3. destroy the Discord client
 *   4. exit the process with code 0
 *
 * Each step is isolated so a failure in one does not skip the rest.
 */
export function registerShutdownHandler(
  client: Client,
  dependencies: ShutdownDependencies = {},
  logger: ShutdownLogger = console.log,
): ShutdownRunner {
  const runner = createShutdownRunner(client, dependencies, logger);

  process.once("SIGINT", () => {
    void runner.run("SIGINT");
  });
  process.once("SIGTERM", () => {
    void runner.run("SIGTERM");
  });

  return runner;
}

/**
 * Pure shutdown runner that does NOT register any process signal handlers.
 * Use this in tests or whenever the caller wants full control over signal
 * delivery.
 */
export function createShutdownRunner(
  client: Client,
  dependencies: ShutdownDependencies = {},
  logger: ShutdownLogger = console.log,
): ShutdownRunner {
  const cancelSession = dependencies.cancelSession ?? cancelActiveSession;
  const destroyVoiceConnections =
    dependencies.destroyVoiceConnections ?? defaultDestroyVoiceConnections;
  const destroyClient = dependencies.destroyClient ?? (() => client.destroy());
  const exit = dependencies.exit ?? ((code) => process.exit(code));
  const now = dependencies.now ?? (() => new Date());
  const onAfterTeardown = dependencies.onAfterTeardown;

  let running = false;

  async function run(signal: ShutdownSignal): Promise<void> {
    if (running) {
      logger(`Shutdown already in progress, ignoring ${signal}`);
      return;
    }
    running = true;
    logger(`Received ${signal} at ${now().toISOString()}, shutting down gracefully`);

    let cancelResult: boolean | null = null;
    try {
      cancelResult = cancelSession();
    } catch (error) {
      logger(`Failed to cancel timekeeper session: ${formatError(error)}`);
    }
    if (cancelResult !== null) {
      logger(`Timekeeper session cancelled: ${cancelResult}`);
    }

    let voiceDestroyed = false;
    try {
      destroyVoiceConnections();
      voiceDestroyed = true;
    } catch (error) {
      logger(`Failed to destroy voice connections: ${formatError(error)}`);
    }
    if (voiceDestroyed) {
      logger("Voice connections destroyed");
    }

    try {
      await destroyClient();
      logger("Discord client destroyed");
    } catch (error) {
      logger(`Failed to destroy Discord client: ${formatError(error)}`);
    }

    if (onAfterTeardown) {
      try {
        await onAfterTeardown();
      } catch (error) {
        logger(`Failed to run post-teardown hook: ${formatError(error)}`);
      }
    }

    logger("Graceful shutdown complete");
    exit(0);
  }

  return { run };
}

function defaultDestroyVoiceConnections(): void {
  const connections = getVoiceConnections();
  for (const connection of connections.values()) {
    connection.destroy();
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
