import type { Client, GuildMember, PartialGuildMember } from "discord.js";
import { ChannelType, Events } from "discord.js";

import { isWelcomeConfigured, type WelcomeConfig, welcomeConfig } from "./config.js";
import { buildWelcomeMessage, type WelcomeMember } from "./messages.js";

type SendableTextChannel = {
  send: (content: string) => Promise<unknown>;
};

export type WelcomeHandlerEvent = {
  member: WelcomeMember;
};

export type HandlerDependencies = {
  config?: WelcomeConfig;
  fetchTextChannel?: (channelId: string) => Promise<SendableTextChannel | null>;
  getBotUserId?: () => string | null;
};

export type WelcomeOutcome =
  | "sent"
  | "skipped-self"
  | "missing-config"
  | "missing-channel"
  | "send-failed";

export function createWelcomeHandler(deps: HandlerDependencies = {}) {
  const config = deps.config ?? welcomeConfig;
  const fetchTextChannel = deps.fetchTextChannel ?? defaultFetchTextChannel;
  const getBotUserId = deps.getBotUserId ?? (() => null);

  return {
    async onMemberJoin(event: WelcomeHandlerEvent): Promise<WelcomeOutcome> {
      const botUserId = getBotUserId();

      if (botUserId && event.member.id === botUserId) {
        return "skipped-self";
      }

      if (!isWelcomeConfigured(config)) {
        return "missing-config";
      }

      const channel = await fetchTextChannel(config.welcomeChannelId);

      if (!channel) {
        return "missing-channel";
      }

      try {
        await channel.send(buildWelcomeMessage(event.member, config));
        return "sent";
      } catch (error) {
        console.error("[welcome] Failed to send welcome message", error);
        return "send-failed";
      }
    },
  };
}

export function registerWelcomeHandlers(client: Client): void {
  const handler = createWelcomeHandler({
    fetchTextChannel: async (channelId) => fetchWelcomeChannel(client, channelId),
    getBotUserId: () => client.user?.id ?? null,
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    await handleDiscordMemberAdd(member, handler);
  });
}

async function handleDiscordMemberAdd(
  member: GuildMember | PartialGuildMember,
  handler: ReturnType<typeof createWelcomeHandler>,
): Promise<void> {
  const resolved = member.partial ? await member.fetch().catch(() => null) : member;
  if (!resolved) {
    return;
  }

  await handler.onMemberJoin({
    member: {
      id: resolved.user.id,
      displayName: resolved.displayName,
    },
  });
}

async function fetchWelcomeChannel(
  client: Client,
  channelId: string,
): Promise<SendableTextChannel | null> {
  const channel = await client.channels.fetch(channelId).catch(() => null);

  if (!channel) {
    return null;
  }

  if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) {
    return channel as unknown as SendableTextChannel;
  }

  if (channel.isTextBased() && "send" in channel) {
    return channel as unknown as SendableTextChannel;
  }

  return null;
}

function defaultFetchTextChannel(): Promise<SendableTextChannel | null> {
  return Promise.resolve(null);
}
