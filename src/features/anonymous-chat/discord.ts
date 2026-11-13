/**
 * discord.js adapters for the `/anon` service — the only place real
 * `Client`/`Guild`/`Channel` objects enter the feature. Everything
 * downstream works on the structural `Anon*Like` types so tests never
 * need a Discord client.
 */
import type { Client, Guild, ThreadChannel } from "discord.js";

import type { AnonChannelLike, AnonGuildLike, AnonMemberLike } from "./permissions.js";

export type DiscordAnonAdapters = {
  fetchChannel: (channelId: string) => Promise<AnonChannelLike | null>;
  fetchGuild: (guildId: string) => Promise<AnonGuildLike | null>;
  fetchMember: (guild: AnonGuildLike, userId: string) => Promise<AnonMemberLike | null>;
  fetchBotMember: (guild: AnonGuildLike) => Promise<AnonMemberLike | null>;
  isThreadMember: (channel: AnonChannelLike, userId: string) => Promise<boolean>;
};

export function createDiscordAnonAdapters(client: Client): DiscordAnonAdapters {
  return {
    fetchChannel: async (channelId) => {
      try {
        const channel = await client.channels.fetch(channelId);
        return (channel as unknown as AnonChannelLike | null) ?? null;
      } catch {
        return null;
      }
    },
    fetchGuild: async (guildId) => {
      try {
        const guild = await client.guilds.fetch(guildId);
        return guild as unknown as AnonGuildLike;
      } catch {
        return null;
      }
    },
    fetchMember: async (guild, userId) => {
      try {
        const member = await (guild as unknown as Guild).members.fetch(userId);
        return member as unknown as AnonMemberLike;
      } catch {
        return null;
      }
    },
    fetchBotMember: async (guild) => {
      try {
        const g = guild as unknown as Guild;
        const me = g.members.me ?? (await g.members.fetch(g.client.user.id));
        return me as unknown as AnonMemberLike;
      } catch {
        return null;
      }
    },
    isThreadMember: async (channel, userId) => {
      try {
        await (channel as unknown as ThreadChannel).members.fetch(userId);
        return true;
      } catch {
        return false;
      }
    },
  };
}
