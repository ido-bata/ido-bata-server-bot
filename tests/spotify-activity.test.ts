import { ActivityType } from "discord.js";
import { describe, expect, it } from "vitest";

import {
  isSpotifyActivity,
  parseSpotifyActivity,
  type SpotifyActivityShape,
} from "../src/features/spotify/activity.js";

describe("spotify activity", () => {
  const spotifyActivity: SpotifyActivityShape = {
    type: ActivityType.Listening,
    name: "Spotify",
    applicationId: null,
    details: "Never Gonna Give You Up",
    state: "Rick Astley",
    syncId: "4uLU6hMCjMI75M1A2tKUQC",
    assets: {
      largeText: "Whenever You Need Somebody",
      largeImage: "spotify:album:123",
      smallText: null,
      smallImage: null,
    },
    timestamps: {
      start: 1_700_000_000_000,
      end: 1_700_000_180_000,
    },
  };

  it("detects a Spotify activity by name", () => {
    expect(isSpotifyActivity(spotifyActivity)).toBe(true);
  });

  it("detects a Spotify activity by applicationId", () => {
    expect(
      isSpotifyActivity({ ...spotifyActivity, name: null, applicationId: "spotify" }),
    ).toBe(true);
  });

  it("rejects non-Spotify listening activity", () => {
    expect(
      isSpotifyActivity({
        type: ActivityType.Listening,
        name: "Apple Music",
        applicationId: null,
      }),
    ).toBe(false);
  });

  it("rejects activities of a different type", () => {
    expect(
      isSpotifyActivity({
        type: ActivityType.Playing,
        name: "Spotify",
        applicationId: null,
      }),
    ).toBe(false);
  });

  it("rejects null or undefined", () => {
    expect(isSpotifyActivity(null)).toBe(false);
    expect(isSpotifyActivity(undefined)).toBe(false);
  });

  it("parses a Spotify activity into a track", () => {
    const track = parseSpotifyActivity([spotifyActivity]);
    expect(track).toEqual({
      title: "Never Gonna Give You Up",
      artist: "Rick Astley",
      album: "Whenever You Need Somebody",
      startedAtMs: 1_700_000_000_000,
      endsAtMs: 1_700_000_180_000,
      trackId: "4uLU6hMCjMI75M1A2tKUQC",
    });
  });

  it("returns null when no activity in the list is Spotify", () => {
    const track = parseSpotifyActivity([
      { type: ActivityType.Playing, name: "Minecraft" },
      { type: ActivityType.Watching, name: "YouTube" },
    ]);
    expect(track).toBeNull();
  });

  it("returns null when the Spotify activity is missing required fields", () => {
    expect(
      parseSpotifyActivity([{ ...spotifyActivity, details: null }]),
    ).toBeNull();
    expect(
      parseSpotifyActivity([{ ...spotifyActivity, state: null }]),
    ).toBeNull();
  });

  it("treats null or undefined activity lists as no Spotify playback", () => {
    expect(parseSpotifyActivity(null)).toBeNull();
    expect(parseSpotifyActivity(undefined)).toBeNull();
  });

  it("ignores non-Spotify entries before finding a Spotify entry", () => {
    const track = parseSpotifyActivity([
      { type: ActivityType.Playing, name: "Visual Studio Code" },
      spotifyActivity,
    ]);
    expect(track?.title).toBe("Never Gonna Give You Up");
  });
});