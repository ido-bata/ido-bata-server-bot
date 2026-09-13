import "dotenv/config";

import { ChannelType, Events } from "discord.js";

import { createDiscordClient } from "./bot/create-discord-client.js";
import { readConfig } from "./config.js";
import { gameActivityConfig } from "./features/game-activity/config.js";
import {
  type GameActivityMessageTarget,
  registerGameActivity,
} from "./features/game-activity/handler.js";
import { registerReactionRoleHandlers } from "./features/reaction-roles/handler.js";
import { registerTimekeeper } from "./features/timekeeper/service.js";

async function main(): Promise<void> {
  const config = readConfig(process.env);
  const client = createDiscordClient({
    enableMessageContentIntent: config.enableMessageContentIntent,
    enablePresenceIntent: config.enablePresenceIntent,
  });

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);
  });

  registerReactionRoleHandlers(client);
  registerTimekeeper(client);
  registerGameActivity(client, gameActivityConfig, {
    expectedGuildId: config.discordGuildId,
    resolveChannel: async (channelId) => {
      const channel = await client.channels.fetch(channelId);
      if (!channel || channel.type === ChannelType.GuildCategory) {
        return null;
      }
      if (!channel.isTextBased() || !("send" in channel)) {
        return null;
      }
      return channel as unknown as GameActivityMessageTarget;
    },
  });

  await client.login(config.discordToken);
}

main().catch((error: unknown) => {
  console.error("Failed to start Discord bot", error);
  process.exitCode = 1;
});
