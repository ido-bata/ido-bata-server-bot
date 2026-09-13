import { Client, GatewayIntentBits, Partials } from "discord.js";

export type CreateDiscordClientOptions = {
  enableMessageContentIntent?: boolean;
  enableGuildMembersIntent?: boolean;
  enablePresenceIntent?: boolean;
};

export function createDiscordClient(options?: CreateDiscordClientOptions): Client {
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
  ];

  if (options?.enableMessageContentIntent) {
    intents.push(GatewayIntentBits.MessageContent);
  }

  if (options?.enableGuildMembersIntent) {
    intents.push(GatewayIntentBits.GuildMembers);
  }

  if (options?.enablePresenceIntent) {
    intents.push(GatewayIntentBits.GuildPresences);
  }

  return new Client({
    intents,
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
  });
}