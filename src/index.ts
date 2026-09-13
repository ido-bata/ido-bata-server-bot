import "dotenv/config";

import { Events } from "discord.js";

import { createDiscordClient } from "./bot/create-discord-client.js";
import { readConfig } from "./config.js";
import { memberAuditConfig } from "./features/member-audit/config.js";
import { registerMemberAuditHandlers } from "./features/member-audit/handler.js";
import { registerReactionRoleHandlers } from "./features/reaction-roles/handler.js";
import { registerShutdownHandler } from "./features/shutdown/handler.js";
import { readSnapshotConfig } from "./features/state-snapshot/config.js";
import {
  createSnapshotRuntime,
  registerStateSnapshotScheduler,
} from "./features/state-snapshot/service.js";
import { registerTimekeeper } from "./features/timekeeper/service.js";

async function main(): Promise<void> {
  const config = readConfig(process.env);
  const client = createDiscordClient({
    enableMessageContentIntent: config.enableMessageContentIntent,
    enableGuildMembersIntent: config.enableGuildMembersIntent,
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

  // State snapshots are opt-in. They run when the bot is ready if
  // STATE_SNAPSHOT_ENCRYPTION_KEY is set; otherwise the scheduler no-ops.
  if (process.env.STATE_SNAPSHOT_ENCRYPTION_KEY) {
    const snapshotRuntime = createSnapshotRuntime(readSnapshotConfig(), {
      encryptionKey: process.env.STATE_SNAPSHOT_ENCRYPTION_KEY,
      runOnReady: process.env.STATE_SNAPSHOT_RUN_ON_READY === "true",
    });
    registerStateSnapshotScheduler(client, snapshotRuntime);
  }

  await client.login(config.discordToken);
}

main().catch((error: unknown) => {
  console.error("Failed to start Discord bot", error);
  process.exitCode = 1;
});
