export type GameActivityConfig = {
  /**
   * When false the handler is a no-op. Set this to true after providing a real
   * channel ID and a non-empty whitelist.
   */
  enabled: boolean;
  /**
   * Channel that receives the rolling "X 人 playing <game>" summary.
   * Must be a text channel the bot can read and write to.
   */
  channelId: string | null;
  /**
   * Game names (case-insensitive) that should be tracked. Anything outside
   * this list is ignored so we do not broadcast sensitive or noisy titles.
   */
  whitelistedGames: string[];
  /**
   * How long a presence observation stays valid without a fresh
   * `PresenceUpdate`. After this elapses the member is dropped from the
   * active list. Acceptance criteria require 5 minutes.
   */
  staleAfterMs: number;
  /**
   * How often the dedicated channel message is re-rendered. The handler
   * also re-renders on every presence change, but the periodic tick
   * guarantees stale entries are cleared even when no one leaves.
   */
  refreshIntervalMs: number;
};

export const gameActivityConfig: GameActivityConfig = {
  enabled: false,
  channelId: null,
  whitelistedGames: [],
  staleAfterMs: 5 * 60_000,
  refreshIntervalMs: 60_000,
};

export function isGameActivityConfigured(config: GameActivityConfig): boolean {
  return (
    config.enabled &&
    typeof config.channelId === "string" &&
    config.channelId.length > 0 &&
    config.whitelistedGames.length > 0
  );
}

/**
 * Returns the canonical whitelist key for a raw activity name. Comparison is
 * case-insensitive and trims surrounding whitespace so that " Apex Legends "
 * and "apex legends" are treated as the same game.
 */
export function normalizeGameName(name: string): string {
  return name.trim().toLowerCase();
}

export function findWhitelistedGame(
  config: GameActivityConfig,
  activityName: string,
): string | null {
  const normalized = normalizeGameName(activityName);
  if (!normalized) {
    return null;
  }

  const match = config.whitelistedGames.find((entry) => normalizeGameName(entry) === normalized);
  return match ?? null;
}
