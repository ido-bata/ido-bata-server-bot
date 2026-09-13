import type { StarboardEmbed, StarboardMessageInfo, StarboardRepostPayload } from "./handler.js";

const DISCORD_EMBED_DESCRIPTION_LIMIT = 4096;
const DISCORD_FIELD_VALUE_LIMIT = 1024;
const DEFAULT_EMBED_COLOR = 0xffd700;

export function buildStarboardPayload(info: StarboardMessageInfo): StarboardRepostPayload {
  const content = info.content.trim().length > 0 ? info.content : "(no text content)";
  const description = truncate(content, DISCORD_EMBED_DESCRIPTION_LIMIT);

  const embed: StarboardEmbed = {
    description,
    color: DEFAULT_EMBED_COLOR,
    author: buildAuthor(info),
    fields: [
      {
        name: "Original",
        value: truncate(`[Jump to message](${info.jumpUrl})`, DISCORD_FIELD_VALUE_LIMIT),
        inline: true,
      },
      {
        name: "Channel",
        value: truncate(`#${info.channelName}`, DISCORD_FIELD_VALUE_LIMIT),
        inline: true,
      },
      {
        name: "Stars",
        value: `⭐ ${info.reactionCount}`,
        inline: true,
      },
    ],
  };

  if (info.imageUrl) {
    embed.image = { url: info.imageUrl };
  }

  if (info.authorAvatarUrl) {
    embed.thumbnail = { url: info.authorAvatarUrl };
  }

  return {
    content: `⭐ ${info.reactionCount} — ${info.jumpUrl}`,
    embeds: [embed],
  };
}

function buildAuthor(info: StarboardMessageInfo): { name: string; icon_url?: string } {
  if (info.authorAvatarUrl) {
    return { name: info.authorTag, icon_url: info.authorAvatarUrl };
  }
  return { name: info.authorTag };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}