import "dotenv/config";

import { Events } from "discord.js";

import { createDiscordClient } from "./bot/create-discord-client.js";
import { readConfig } from "./config.js";
import { registerIcalCalendar } from "./features/ical-calendar/index.js";
import { registerReactionRoleHandlers } from "./features/reaction-roles/handler.js";
import { registerTimekeeper } from "./features/timekeeper/service.js";

async function main(): Promise<void> {
  const config = readConfig(process.env);
  const client = createDiscordClient({
    enableMessageContentIntent: config.enableMessageContentIntent,
  });

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);
  });

  registerReactionRoleHandlers(client);
  registerTimekeeper(client);
  const icalService = registerIcalCalendar(client, {
    onReady: (service) => {
      service.startScheduler();
      void service
        .fetchAndCacheAll()
        .catch((error: unknown) => console.error("[ical-calendar] initial fetch failed", error));
    },
  });

  process.on("beforeExit", () => {
    icalService.stopScheduler();
  });

  await client.login(config.discordToken);
}

main().catch((error: unknown) => {
  console.error("Failed to start Discord bot", error);
  process.exitCode = 1;
});
