import type { Client, MessageReaction, PartialMessageReaction, PartialUser, User } from "discord.js";
import { Events } from "discord.js";

import type { EmojiLike } from "../reaction-roles/config.js";
import { matchesStarEmoji, starboardConfig } from "./config.js";
import { buildStarboardPayload } from "./embed.js";

export type StarboardReactionEvent = {
  emoji: EmojiLike;
  guildId: string;
  messageId: string;
  channelId: string;
};

export type StarboardMessageInfo = {
  authorTag: string;
  authorAvatarUrl: string | null;
  content: string;
  reactionCount: number;
  jumpUrl: string;
  channelName: string;
  imageUrl: string | null;
  sourceMessageId: string;
  isAuthorBot: boolean;
  isNsfw: boolean;
};

export type StarboardEmbed = {
  description?: string;
  color?: number;
  author?: { name: string; icon_url?: string };
  fields?: { name: string; value: string; inline?: boolean }[];
  image?: { url: string };
  thumbnail?: { url: string };
};

export type StarboardRepostPayload = {
  content: string;
  embeds: StarboardEmbed[];
};

export type StarboardDependencies = {
  fetchMessageInfo?: (channelId: string, messageId: string) => Promise<StarboardMessageInfo | null>;
  countStarReactions?: (channelId: string, messageId: string, emoji: EmojiLike) => Promise<number>;
  sendRepost?: (channelId: string, payload: StarboardRepostPayload) => Promise<void>;
};

export type StarboardHandler = {
  onReactionAdd: (event: StarboardReactionEvent) => Promise<void>;
  repostedMessageIds: ReadonlySet<string>;
};

const DEFAULT_FETCH_MESSAGE_INFO: NonNullable<StarboardDependencies["fetchMessageInfo"]> =
  async () => {
    throw new Error("starboard: fetchMessageInfo dependency is not provided");
  };

const DEFAULT_COUNT_STAR_REACTIONS: NonNullable<StarboardDependencies["countStarReactions"]> =
  async () => {
    throw new Error("starboard: countStarReactions dependency is not provided");
  };

const DEFAULT_SEND_REPOST: NonNullable<StarboardDependencies["sendRepost"]> = async () => {
  throw new Error("starboard: sendRepost dependency is not provided");
};

export function createStarboardHandler(deps: StarboardDependencies = {}): StarboardHandler {
  const fetchMessageInfo = deps.fetchMessageInfo ?? DEFAULT_FETCH_MESSAGE_INFO;
  const countStarReactions = deps.countStarReactions ?? DEFAULT_COUNT_STAR_REACTIONS;
  const sendRepost = deps.sendRepost ?? DEFAULT_SEND_REPOST;

  const repostedMessageIds = new Set<string>();
  // Per-messageId chain so concurrent reaction events for the same message
  // are serialized: the next call waits for the previous one's check-and-send
  // to finish (so a second event sees the freshly-added id and bails out).
  const inflightSends = new Map<string, Promise<void>>();

  function enqueue(messageId: string, run: () => Promise<void>): Promise<void> {
    const previous = inflightSends.get(messageId) ?? Promise.resolve();
    // Swallow rejection from the previous run so it does not poison the chain;
    // failures are reported via the promise returned for the current invocation.
    const next = previous.catch(() => undefined).then(run);
    inflightSends.set(messageId, next);
    // Track completion to drop the map entry once no further work is pending.
    // The trailing .catch keeps this fire-and-forget cleanup from surfacing
    // as an unhandled rejection when `run` rejects.
    void next
      .finally(() => {
        if (inflightSends.get(messageId) === next) {
          inflightSends.delete(messageId);
        }
      })
      .catch(() => undefined);
    return next;
  }

  async function handleReaction(event: StarboardReactionEvent): Promise<void> {
    if (!matchesStarEmoji(event.emoji, starboardConfig)) {
      return;
    }

    return enqueue(event.messageId, async () => {
      // Re-check after acquiring the queue slot: a prior invocation may have
      // already claimed and reposted this messageId while we were waiting.
      if (repostedMessageIds.has(event.messageId)) {
        return;
      }

      const info = await fetchMessageInfo(event.channelId, event.messageId);
      if (!info) {
        return;
      }

      if (info.isAuthorBot) {
        return;
      }

      if (info.isNsfw) {
        return;
      }

      const count = await countStarReactions(event.channelId, event.messageId, event.emoji);
      if (count < starboardConfig.threshold) {
        return;
      }

      // Claim BEFORE sending so concurrent reaction events queued behind us
      // see the id and skip; release the claim only on failure so a later
      // reaction event can retry.
      repostedMessageIds.add(event.messageId);
      const payload = buildStarboardPayload({ ...info, reactionCount: count });
      try {
        await sendRepost(starboardConfig.channelId, payload);
      } catch (error) {
        repostedMessageIds.delete(event.messageId);
        throw error;
      }
    });
  }

  return {
    onReactionAdd: handleReaction,
    repostedMessageIds,
  };
}

export function registerStarboardHandlers(client: Client): void {
  const handler = createStarboardHandler({
    fetchMessageInfo: async (channelId, messageId) => {
      const channel = client.channels.cache.get(channelId);

      if (!channel || !("messages" in channel)) {
        return null;
      }

      const textChannel = channel as {
        messages: { fetch: (id: string) => Promise<unknown> };
      };

      const message = (await textChannel.messages.fetch(messageId)) as
        | (Record<string, unknown> & {
            author?: { tag?: string; bot?: boolean; displayAvatarURL?: () => string };
            content?: string;
            url?: string;
            attachments?: { size: number; first: () => { url: string } | null };
            channel?: { name?: string; nsfw?: boolean };
          })
        | null;

      if (!message || !message.author) {
        return null;
      }

      const author = message.author;
      const attachments = message.attachments;
      const imageUrl = attachments && attachments.size > 0 ? (attachments.first()?.url ?? null) : null;

      return {
        authorTag: author.tag ?? "unknown",
        authorAvatarUrl: author.displayAvatarURL ? author.displayAvatarURL() : null,
        content: message.content ?? "",
        reactionCount: 0,
        jumpUrl: message.url ?? "",
        channelName: message.channel?.name ?? "",
        imageUrl,
        sourceMessageId: messageId,
        isAuthorBot: Boolean(author.bot),
        isNsfw: Boolean(message.channel?.nsfw),
      };
    },
    countStarReactions: async (channelId, messageId, emoji) => {
      const channel = client.channels.cache.get(channelId);

      if (!channel || !("messages" in channel)) {
        return 0;
      }

      const textChannel = channel as {
        messages: {
          fetch: (id: string) => Promise<{
            reactions: { cache: { get: (key: string) => { count: number } | undefined } };
          }>;
        };
      };

      try {
        const message = await textChannel.messages.fetch(messageId);
        const key = emoji.id ?? emoji.name ?? "";
        const reaction = message.reactions.cache.get(key);
        return reaction?.count ?? 0;
      } catch {
        return 0;
      }
    },
    sendRepost: async (channelId, payload) => {
      const channel = client.channels.cache.get(channelId);

      if (!channel || !("send" in channel)) {
        return;
      }

      const sendable = channel as {
        send: (options: {
          content?: string;
          embeds?: StarboardEmbed[];
        }) => Promise<unknown>;
      };

      await sendable.send({
        content: payload.content,
        embeds: payload.embeds,
      });
    },
  });

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    await handleDiscordReactionEvent(reaction, user, handler.onReactionAdd);
  });
}

async function handleDiscordReactionEvent(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  apply: (event: StarboardReactionEvent) => Promise<void>,
): Promise<void> {
  if (user.bot) {
    return;
  }

  const resolved = reaction.partial ? await reaction.fetch() : reaction;
  const guildId = resolved.message.guildId;

  if (!guildId) {
    return;
  }

  await apply({
    emoji: { id: resolved.emoji.id, name: resolved.emoji.name },
    guildId,
    messageId: resolved.message.id,
    channelId: resolved.message.channelId,
  });
}