import { GatewayIntentBits } from "discord.js";
import { describe, expect, it } from "vitest";

import { createDiscordClient } from "../src/bot/create-discord-client.js";

describe("createDiscordClient", () => {
  it("enables non-privileged intents required for reaction and voice features", () => {
    const client = createDiscordClient();

    expect(client.options.intents.has(GatewayIntentBits.Guilds)).toBe(true);
    expect(client.options.intents.has(GatewayIntentBits.GuildMessages)).toBe(true);
    expect(client.options.intents.has(GatewayIntentBits.GuildMessageReactions)).toBe(true);
    expect(client.options.intents.has(GatewayIntentBits.GuildVoiceStates)).toBe(true);
    expect(client.options.intents.has(GatewayIntentBits.MessageContent)).toBe(false);
    expect(client.options.intents.has(GatewayIntentBits.GuildPresences)).toBe(false);
  });

  it("includes message content intent only when enabled", () => {
    const client = createDiscordClient({ enableMessageContentIntent: true });

    expect(client.options.intents.has(GatewayIntentBits.MessageContent)).toBe(true);
  });

  it("includes guild presences intent only when enabled", () => {
    const client = createDiscordClient({ enablePresenceIntent: true });

    expect(client.options.intents.has(GatewayIntentBits.GuildPresences)).toBe(true);
  });
});
