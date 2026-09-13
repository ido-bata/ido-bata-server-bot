import type { SpotifyTrack } from "./activity.js";

export type NowPlayingEmbedContent = {
  title: string;
  description: string;
};

export type NowPlayingListener = {
  userId: string;
  displayName: string;
};

export function formatNowPlayingEmbed(
  track: SpotifyTrack,
  listener: NowPlayingListener,
): NowPlayingEmbedContent {
  const title = `${listener.displayName} は今これを聴いています`;
  const lines = [`**${track.title}**`, `アーティスト: ${track.artist}`];
  if (track.album) {
    lines.push(`アルバム: ${track.album}`);
  }
  if (track.trackId) {
    lines.push(`track id: ${track.trackId}`);
  }
  return {
    title,
    description: lines.join("\n"),
  };
}

export type StopReason = "ended" | "stale" | "left";

export function formatStoppedEmbed(
  listener: NowPlayingListener,
  reason: StopReason,
): NowPlayingEmbedContent {
  const title = `${listener.displayName} は再生を停止しました`;
  let description = "再生停止を検知しました。";
  if (reason === "stale") {
    description = "最終更新から時間が経過したため表示を解除しました。";
  } else if (reason === "left") {
    description = "サーバ退出のため表示を解除しました。";
  }
  return { title, description };
}