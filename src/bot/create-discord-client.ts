import { Client, GatewayIntentBits, Partials } from "discord.js";

export type DiscordClientOptions = {
  enableMessageContentIntent?: boolean;
  /**
   * Privileged intent required to receive `PresenceUpdate` events.
   * Defaults to `false` — opt in via `BotConfig.enablePresenceIntent`.
   */
  enablePresenceIntent?: boolean;
};

export function createDiscordClient(options: DiscordClientOptions = {}): Client {
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
  ];

  if (options.enableMessageContentIntent) {
    intents.push(GatewayIntentBits.MessageContent);
  }

  if (options.enablePresenceIntent) {
    intents.push(GatewayIntentBits.GuildPresences);
  }

  return new Client({
    intents,
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
  });
}
