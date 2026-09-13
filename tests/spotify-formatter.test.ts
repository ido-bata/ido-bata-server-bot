import { describe, expect, it } from "vitest";

import { formatNowPlayingEmbed, formatStoppedEmbed } from "../src/features/spotify/formatter.js";

const baseTrack = {
  title: "Never Gonna Give You Up",
  artist: "Rick Astley",
  album: "Whenever You Need Somebody",
  startedAtMs: 1_700_000_000_000,
  endsAtMs: 1_700_000_180_000,
  trackId: "4uLU6hMCjMI75M1A2tKUQC",
};

const listener = { userId: "user-1", displayName: "alice" };

describe("spotify formatter", () => {
  it("formats a now-playing embed with title, artist, album and track id", () => {
    const embed = formatNowPlayingEmbed(baseTrack, listener);
    expect(embed.title).toBe("alice は今これを聴いています");
    expect(embed.description).toContain("**Never Gonna Give You Up**");
    expect(embed.description).toContain("アーティスト: Rick Astley");
    expect(embed.description).toContain("アルバム: Whenever You Need Somebody");
    expect(embed.description).toContain("track id: 4uLU6hMCjMI75M1A2tKUQC");
  });

  it("omits album when null", () => {
    const embed = formatNowPlayingEmbed({ ...baseTrack, album: null }, listener);
    expect(embed.description).not.toContain("アルバム:");
  });

  it("omits track id when null", () => {
    const embed = formatNowPlayingEmbed({ ...baseTrack, trackId: null }, listener);
    expect(embed.description).not.toContain("track id:");
  });

  it("formats a stopped embed for the ended reason", () => {
    const embed = formatStoppedEmbed(listener, "ended");
    expect(embed.title).toBe("alice は再生を停止しました");
    expect(embed.description).toContain("再生停止");
  });

  it("formats a stopped embed for the stale reason", () => {
    const embed = formatStoppedEmbed(listener, "stale");
    expect(embed.description).toContain("最終更新");
  });

  it("formats a stopped embed for the left reason", () => {
    const embed = formatStoppedEmbed(listener, "left");
    expect(embed.description).toContain("サーバ退出");
  });
});