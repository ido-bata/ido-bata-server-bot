import type { Channel, Client, TextBasedChannel } from "discord.js";
import { ChannelType, Events } from "discord.js";

import {
  isSpotifyActivity,
  parseSpotifyActivity,
  type SpotifyActivityShape,
} from "./activity.js";
import { type SpotifyConfig, isSpotifyConfigured } from "./config.js";
import {
  type NowPlayingEmbedContent,
  type NowPlayingHandlerResult,
  createSpotifyNowPlayingHandler,
} from "./handler.js";
import { NowPlayingStore, type StoredNowPlaying } from "./state.js";

const PRUNE_INTERVAL_MS = 60_000;

type EditableMessage = {
  edit: (content: { embeds: NowPlayingEmbedContent[] }) => Promise<unknown>;
  delete: () => Promise<unknown>;
};

type SendableChannel = {
  send: (content: { embeds: NowPlayingEmbedContent[] }) => Promise<EditableMessage>;
};

function isSendableChannel(channel: Channel | null): channel is TextBasedChannel & SendableChannel {
  if (!channel) {
    return false;
  }
  if (!channel.isTextBased()) {
    return false;
  }
  if (channel.type !== ChannelType.DM && channel.type !== ChannelType.GuildText) {
    return false;
  }
  return typeof (channel as { send?: unknown }).send === "function";
}

async function resolvePublicChannel(
  client: Client,
  channelId: string,
): Promise<(TextBasedChannel & SendableChannel) | null> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !isSendableChannel(channel)) {
    return null;
  }
  return channel;
}

async function resolveDmChannel(
  client: Client,
  userId: string,
): Promise<(TextBasedChannel & SendableChannel) | null> {
  const user = await client.users.fetch(userId);
  if (!user) {
    return null;
  }
  const dm = await user.createDM().catch(() => null);
  if (!dm || !isSendableChannel(dm)) {
    return null;
  }
  return dm;
}

function toEmbedContent(content: NowPlayingEmbedContent): NowPlayingEmbedContent {
  return content;
}

function toEmbedPayload(content: NowPlayingEmbedContent): { embeds: NowPlayingEmbedContent[] } {
  return { embeds: [toEmbedContent(content)] };
}

export function createSpotifyService(
  client: Client,
  config: SpotifyConfig,
): { stop: () => void } {
  if (!isSpotifyConfigured(config)) {
    console.warn(
      "Spotify now-playing is disabled. Set DISCORD_ENABLE_SPOTIFY=true and SPOTIFY_CHANNEL_ID (for public mode) to enable.",
    );
    return { stop: () => undefined };
  }

  const store = new NowPlayingStore(config.staleAfterMs);

  const sendEmbed = async (
    userId: string,
    embed: NowPlayingEmbedContent,
  ): Promise<string | null> => {
    const target = await resolveEmbedTarget(client, config, userId);
    if (!target) {
      return null;
    }
    const message = await target.send(toEmbedPayload(embed));
    return message ? (extractMessageId(message) ?? null) : null;
  };

  const editEmbed = async (
    userId: string,
    messageId: string,
    embed: NowPlayingEmbedContent,
  ): Promise<void> => {
    const target = await resolveEmbedTarget(client, config, userId);
    if (!target) {
      throw new Error(`No channel to edit Spotify embed for ${userId}`);
    }
    const fetched = await fetchMessage(target, messageId);
    if (!fetched) {
      throw new Error(`Spotify embed message ${messageId} not found for ${userId}`);
    }
    await fetched.edit(toEmbedPayload(embed));
  };

  const deleteEmbed = async (userId: string, messageId: string): Promise<void> => {
    const target = await resolveEmbedTarget(client, config, userId);
    if (!target) {
      return;
    }
    const fetched = await fetchMessage(target, messageId);
    if (!fetched) {
      return;
    }
    await fetched.delete().catch(() => undefined);
  };

  const handler = createSpotifyNowPlayingHandler({
    store,
    sendEmbed: (userId, embed) => sendEmbed(userId, embed),
    editEmbed,
    deleteEmbed,
  });

  const onPresenceUpdate = (oldPresence: unknown, newPresence: unknown): void => {
    void handler
      .onPresenceUpdate(mapPresenceUpdate(newPresence))
      .catch((error: unknown) => {
        console.error("Spotify now-playing handler failed", error);
      });
  };

  client.on(Events.PresenceUpdate, onPresenceUpdate);

  const pruneInterval = setInterval(() => {
    void handler
      .pruneStale()
      .then((results: NowPlayingHandlerResult[]) => {
        if (results.length > 0) {
          console.log(`Pruned ${results.length} stale Spotify now-playing entries`);
        }
      })
      .catch((error: unknown) => {
        console.error("Spotify prune failed", error);
      });
  }, PRUNE_INTERVAL_MS);

  if (typeof pruneInterval.unref === "function") {
    pruneInterval.unref();
  }

  return {
    stop: () => {
      client.removeListener(Events.PresenceUpdate, onPresenceUpdate);
      clearInterval(pruneInterval);
    },
  };
}

export function registerSpotifyNowPlaying(client: Client, config: SpotifyConfig): { stop: () => void } {
  return createSpotifyService(client, config);
}

function mapPresenceUpdate(presence: unknown): {
  userId: string;
  guildId: string | null;
  displayName: string;
  activities: ReadonlyArray<SpotifyActivityShape | null | undefined> | null;
} {
  if (!presence || typeof presence !== "object") {
    return { userId: "", guildId: null, displayName: "", activities: null };
  }

  const record = presence as {
    userId?: string;
    guildId?: string | null;
    member?: { displayName?: string | null; user?: { username?: string | null } } | null;
    user?: { username?: string | null; globalName?: string | null } | null;
    activities?: ReadonlyArray<SpotifyActivityShape | null | undefined> | null;
  };

  const activities = record.activities ?? null;
  const displayName =
    record.member?.displayName ??
    record.user?.globalName ??
    record.user?.username ??
    record.userId ??
    "";

  return {
    userId: record.userId ?? "",
    guildId: record.guildId ?? null,
    displayName,
    activities,
  };
}

async function resolveEmbedTarget(
  client: Client,
  config: SpotifyConfig,
  userId: string,
): Promise<(TextBasedChannel & SendableChannel) | null> {
  if (config.visibility === "public") {
    if (!config.embedChannelId) {
      return null;
    }
    return resolvePublicChannel(client, config.embedChannelId);
  }
  return resolveDmChannel(client, userId);
}

async function fetchMessage(
  target: TextBasedChannel & SendableChannel,
  messageId: string,
): Promise<EditableMessage | null> {
  const messages = (target as { messages?: { fetch: (id: string) => Promise<unknown> } }).messages;
  if (!messages) {
    return null;
  }
  const message = (await messages.fetch(messageId)) as EditableMessage | null;
  return message;
}

function extractMessageId(message: EditableMessage): string | null {
  const id = (message as unknown as { id?: string }).id;
  return id ?? null;
}

// Re-export for tests
export { isSpotifyActivity, parseSpotifyActivity };
export type { StoredNowPlaying };