export type StarboardConfig = {
  emojiName: string;
  threshold: number;
  channelId: string;
  embedColor: number;
};

// Replace the placeholder channelId with your actual Discord starboard channel ID
// before the feature becomes operational.
export const starboardConfig: StarboardConfig = {
  emojiName: "⭐",
  threshold: 5,
  channelId: "STARBOARD_CHANNEL_ID_PLACEHOLDER",
  embedColor: 0xffd700,
};

export function isStarboardConfigured(config: StarboardConfig): boolean {
  return config.channelId.length > 0 && !config.channelId.includes("PLACEHOLDER");
}

export type StarEmojiLike = {
  id: string | null;
  name: string | null;
};

export function matchesStarEmoji(emoji: StarEmojiLike, config: StarboardConfig): boolean {
  if (emoji.id) {
    return false;
  }
  return emoji.name === config.emojiName;
}