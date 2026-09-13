import { ActivityType } from "discord.js";

export const SPOTIFY_ACTIVITY_NAME = "Spotify";
export const SPOTIFY_APPLICATION_ID = "spotify";

export type SpotifyActivityShape = {
  type: number;
  name?: string | null;
  applicationId?: string | null;
  details?: string | null;
  state?: string | null;
  syncId?: string | null;
  assets?: {
    largeText?: string | null;
    smallText?: string | null;
    largeImage?: string | null;
    smallImage?: string | null;
  } | null;
  timestamps?: {
    start?: number | null;
    end?: number | null;
  } | null;
};

export type SpotifyTrack = {
  title: string;
  artist: string;
  album: string | null;
  startedAtMs: number | null;
  endsAtMs: number | null;
  trackId: string | null;
};

export function isSpotifyActivity(
  activity: SpotifyActivityShape | null | undefined,
): boolean {
  if (!activity) {
    return false;
  }
  if (activity.type !== ActivityType.Listening) {
    return false;
  }
  if (activity.applicationId === SPOTIFY_APPLICATION_ID) {
    return true;
  }
  return activity.name === SPOTIFY_ACTIVITY_NAME;
}

export function parseSpotifyActivity(
  activities:
    | ReadonlyArray<SpotifyActivityShape | null | undefined>
    | null
    | undefined,
): SpotifyTrack | null {
  if (!activities) {
    return null;
  }
  for (const activity of activities) {
    if (isSpotifyActivity(activity) && activity) {
      const track = toSpotifyTrack(activity);
      if (track) {
        return track;
      }
    }
  }
  return null;
}

function toSpotifyTrack(activity: SpotifyActivityShape): SpotifyTrack | null {
  const title = activity.details?.trim();
  const artist = activity.state?.trim();
  if (!title || !artist) {
    return null;
  }
  const album = activity.assets?.largeText?.trim() ?? null;
  return {
    title,
    artist,
    album: album && album.length > 0 ? album : null,
    startedAtMs: numericTimestamp(activity.timestamps?.start),
    endsAtMs: numericTimestamp(activity.timestamps?.end),
    trackId: activity.syncId?.trim() ? activity.syncId.trim() : null,
  };
}

function numericTimestamp(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  return num;
}