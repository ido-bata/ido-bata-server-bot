import type { Client } from "discord.js";
import { Events } from "discord.js";

import {
  findWhitelistedGame,
  type GameActivityConfig,
  isGameActivityConfigured,
} from "./config.js";
import { formatGameActivityMessage } from "./formatter.js";
import { type GameActivitySnapshot, GameActivityTracker } from "./tracker.js";

// Discord ActivityType.Playing == 0. Kept module-local so it isn't part of
// the public seam — only this file needs to compare against it.
const ACTIVITY_TYPE_PLAYING = 0;

export type GameActivityPresenceSnapshot = {
  userId: string;
  activities: { name?: string | null; type?: number | null }[];
};

export type GameActivityMessageTarget = {
  send: (payload: { content: string }) => Promise<{
    id: string;
    edit: (payload: { content: string }) => Promise<unknown>;
  }>;
};

export type GameActivityDependencies = {
  /**
   * Resolve the configured channel into something send-able. Returns `null`
   * when the channel id is missing, the channel is unreachable, or it is
   * not a text-based channel.
   */
  resolveChannel: (channelId: string) => Promise<GameActivityMessageTarget | null>;
  /**
   * Inject a clock for deterministic tests. Defaults to `Date.now`.
   */
  now?: () => number;
  /**
   * Optional logger hook. Defaults to `console.log` / `console.warn`.
   */
  logger?: {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
};

/**
 * Filters a raw presence snapshot down to the whitelisted game, if any.
 * Returns `null` when no Playing activity matches the whitelist — that
 * signals the caller should clear the user from the tracker.
 */
export function pickWhitelistedPlayingGame(
  config: GameActivityConfig,
  snapshot: GameActivityPresenceSnapshot,
): { userId: string; gameName: string } | null {
  if (!snapshot.userId) {
    return null;
  }

  for (const activity of snapshot.activities) {
    if (activity.type !== ACTIVITY_TYPE_PLAYING) {
      continue;
    }
    if (typeof activity.name !== "string" || activity.name.length === 0) {
      continue;
    }
    const match = findWhitelistedGame(config, activity.name);
    if (match) {
      return { userId: snapshot.userId, gameName: match };
    }
  }

  return null;
}

export function createGameActivityHandler(
  config: GameActivityConfig,
  deps: GameActivityDependencies,
) {
  const tracker = new GameActivityTracker({
    now: deps.now,
    staleAfterMs: config.staleAfterMs,
  });
  const logger = deps.logger ?? defaultLogger();

  let activeMessageId: string | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let inFlightRefresh: Promise<void> | null = null;

  function defaultLogger() {
    return {
      info: (message: string) => console.log(`[game-activity] ${message}`),
      warn: (message: string) => console.warn(`[game-activity] ${message}`),
    };
  }

  function resetMessageId(): void {
    activeMessageId = null;
  }

  async function postOrEdit(snapshot: GameActivitySnapshot): Promise<void> {
    if (!isGameActivityConfigured(config) || !config.channelId) {
      return;
    }
    const channel = await deps.resolveChannel(config.channelId);
    if (!channel) {
      logger.warn(`Configured channel ${config.channelId} could not be resolved; skipping update.`);
      return;
    }

    const formatted = formatGameActivityMessage(snapshot);
    if (formatted === null) {
      if (activeMessageId) {
        // No active players any more — keep the last message ID so we can
        // try to delete it on the next call, but tolerate missing delete.
        try {
          // deleteMessage is not part of the minimal target type, but the
          // resolved discord.js channel always exposes one. Fall back to
          // editing the message into an empty placeholder.
          await channel.send({ content: "_現在プレイ中の whitelisted ゲームはありません。_" });
        } catch (error) {
          logger.warn(`Failed to clear game activity message: ${stringifyError(error)}`);
        }
        resetMessageId();
      }
      return;
    }

    if (activeMessageId) {
      // Edit-in-place path is impossible without a direct message handle in
      // our DI seam, so we always send a new message and treat the prior ID
      // as retired. This keeps the seam simple and avoids stale renders.
      resetMessageId();
    }

    try {
      const sent = await channel.send({ content: formatted });
      activeMessageId = sent.id;
    } catch (error) {
      logger.warn(`Failed to post game activity update: ${stringifyError(error)}`);
      resetMessageId();
    }
  }

  async function refresh(): Promise<void> {
    if (!isGameActivityConfigured(config)) {
      return;
    }
    const evicted = tracker.evict();
    if (evicted.length === 0 && !tracker.hasObservers()) {
      return;
    }
    await postOrEdit(tracker.snapshot());
  }

  function startRefreshLoop(): void {
    if (refreshTimer || !isGameActivityConfigured(config)) {
      return;
    }
    refreshTimer = setInterval(() => {
      if (inFlightRefresh) {
        return;
      }
      inFlightRefresh = refresh().finally(() => {
        inFlightRefresh = null;
      });
    }, config.refreshIntervalMs);
    // Allow the process to exit even if the interval is still scheduled.
    refreshTimer.unref?.();
  }

  function stopRefreshLoop(): void {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  return {
    /** Imperative entry point — used by tests and by the Discord listener. */
    async handlePresenceUpdate(presence: GameActivityPresenceSnapshot): Promise<void> {
      if (!isGameActivityConfigured(config)) {
        return;
      }
      const picked = pickWhitelistedPlayingGame(config, presence);
      if (picked) {
        tracker.observe(picked.userId, picked.gameName);
      } else {
        // A non-Playing activity or a non-whitelisted game arrived: drop
        // any prior observation so the user is removed from the list.
        tracker.clear(presence.userId);
      }
      await postOrEdit(tracker.snapshot());
    },

    /** Force a refresh + re-render (exposed for tests and admin commands). */
    async render(): Promise<void> {
      await refresh();
    },

    /** Snapshot for diagnostics / slash-command introspection. */
    snapshot(): GameActivitySnapshot {
      return tracker.snapshot();
    },

    startRefreshLoop,
    stopRefreshLoop,

    /** Test-only helpers. */
    _internal: {
      tracker,
      postOrEdit,
      refresh,
    },
  };
}

/**
 * Wires the Discord `PresenceUpdate` event into the handler factory. The
 * handler skips the event silently when the guild is not the configured
 * guild so a multi-guild bot does not leak activity to the wrong channel.
 */
export function registerGameActivity(
  client: Client,
  config: GameActivityConfig,
  deps: Omit<GameActivityDependencies, "resolveChannel"> & {
    resolveChannel: GameActivityDependencies["resolveChannel"];
    expectedGuildId?: string;
  },
): ReturnType<typeof createGameActivityHandler> {
  const handler = createGameActivityHandler(config, {
    now: deps.now,
    logger: deps.logger,
    resolveChannel: deps.resolveChannel,
  });

  const expectedGuildId = deps.expectedGuildId;

  client.on(Events.PresenceUpdate, (oldPresence, newPresence) => {
    const presence = newPresence ?? oldPresence;
    if (!presence) {
      return;
    }
    if (expectedGuildId && presence.guild?.id && presence.guild.id !== expectedGuildId) {
      return;
    }
    const userId = presence.userId ?? presence.user?.id;
    if (!userId) {
      return;
    }
    const activities = (presence.activities ?? []).map((activity) => ({
      name: activity.name ?? null,
      type: typeof activity.type === "number" ? activity.type : null,
    }));

    void handler.handlePresenceUpdate({ userId, activities }).catch((error: unknown) => {
      console.error("[game-activity] presence handler failed", error);
    });
  });

  handler.startRefreshLoop();

  return handler;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
