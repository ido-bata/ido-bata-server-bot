export type SpotifyVisibility = "self" | "public";

export type SpotifyConfig = {
  enabled: boolean;
  visibility: SpotifyVisibility;
  embedChannelId: string | null;
  staleAfterMs: number;
};

export const defaultSpotifyConfig: SpotifyConfig = {
  enabled: false,
  visibility: "public",
  embedChannelId: null,
  staleAfterMs: 5 * 60 * 1000,
};

export function readSpotifyConfig(env: NodeJS.ProcessEnv): SpotifyConfig {
  const enabled = env.DISCORD_ENABLE_SPOTIFY === "true";
  const visibility = env.SPOTIFY_VISIBILITY === "self" ? "self" : "public";
  const embedChannelId = env.SPOTIFY_CHANNEL_ID?.trim() ? env.SPOTIFY_CHANNEL_ID.trim() : null;
  const rawStale = env.SPOTIFY_STALE_AFTER_MS ? Number(env.SPOTIFY_STALE_AFTER_MS) : NaN;
  const staleAfterMs = Number.isFinite(rawStale) && rawStale > 0 ? rawStale : 5 * 60 * 1000;

  return {
    enabled,
    visibility,
    embedChannelId,
    staleAfterMs,
  };
}

export function isSpotifyConfigured(config: SpotifyConfig): boolean {
  if (!config.enabled) {
    return false;
  }
  if (config.visibility === "public") {
    return config.embedChannelId !== null;
  }
  return true;
}