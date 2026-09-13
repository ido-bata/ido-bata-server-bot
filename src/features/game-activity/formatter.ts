import type { GameActivitySnapshot } from "./tracker.js";

/**
 * Formats the dedicated channel message for the game activity feature.
 *
 * The accepted contract from the issue body is "X 人 playing <game>". We keep
 * that as the headline and add a per-game list so the message is useful when
 * several titles are active at once. When no one is playing we return `null`
 * so the caller can skip sending an update (or delete the previous message).
 */
export function formatGameActivityMessage(snapshot: GameActivitySnapshot): string | null {
  if (snapshot.entries.length === 0) {
    return null;
  }

  const header = `🎮 現在プレイ中: ${snapshot.totalPlayers}人`;
  const lines = snapshot.entries.map((entry) => {
    const count = entry.userIds.size;
    const players = [...entry.userIds].sort((left, right) => left.localeCompare(right));
    const mentions = players.map((userId) => `<@${userId}>`).join(", ");
    return `- **${entry.gameName}**: ${count}人 playing (${mentions})`;
  });

  return [header, ...lines].join("\n");
}

/**
 * Returns a short summary used in logs and slash-command responses.
 */
export function summarizeGameActivity(snapshot: GameActivitySnapshot): string {
  if (snapshot.entries.length === 0) {
    return "現在プレイ中の whitelisted ゲームはありません。";
  }

  const segments = snapshot.entries.map((entry) => `${entry.gameName}: ${entry.userIds.size}人`);
  return segments.join(" / ");
}
