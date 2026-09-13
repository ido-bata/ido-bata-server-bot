import "dotenv/config";

import { Events } from "discord.js";

import { createDiscordClient } from "./bot/create-discord-client.js";
import { readConfig } from "./config.js";
import { memberAuditConfig } from "./features/member-audit/config.js";
import { registerMemberAuditHandlers } from "./features/member-audit/handler.js";
import { registerReactionRoleHandlers } from "./features/reaction-roles/handler.js";
import { registerShutdownHandler } from "./features/shutdown/handler.js";
import { isSpotifyConfigured, readSpotifyConfig } from "./features/spotify/config.js";
import { registerSpotifyNowPlaying } from "./features/spotify/service.js";
import { registerTimekeeper } from "./features/timekeeper/service.js";

async function main(): Promise<void> {
  const config = readConfig(process.env);
  const client = createDiscordClient({
    enableMessageContentIntent: config.enableMessageContentIntent,
    enableGuildMembersIntent: config.enableGuildMembersIntent,
    enablePresenceIntent: config.enablePresenceIntent,
  });

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);
  });

  registerReactionRoleHandlers(client);
  registerMemberAuditHandlers(client, {
    config: memberAuditConfig,
    sendMessage: async (channelId, content) => {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !("send" in channel) || typeof channel.send !== "function") {
        throw new Error(`member-audit: channel ${channelId} is not a text channel`);
      }
      await channel.send(content);
    },
  });
  registerTimekeeper(client);
  registerShutdownHandler(client);

  const spotifyConfig = readSpotifyConfig(process.env);
  if (isSpotifyConfigured(spotifyConfig)) {
    if (!config.enablePresenceIntent) {
      console.warn(
        "Spotify now-playing is configured but DISCORD_ENABLE_PRESENCE=true is required to receive PresenceUpdate events.",
      );
    } else {
      registerSpotifyNowPlaying(client, spotifyConfig);
    }
  }

  await client.login(config.discordToken);
}

main().catch((error: unknown) => {
  console.error("Failed to start Discord bot", error);
  process.exitCode = 1;
});
