import { SlashCommandBuilder } from "discord.js";

import type { SlashCommandDefinition } from "../types.js";

export const pingCommand: SlashCommandDefinition = {
  name: "ping",
  description: "Replies with Pong! and the WebSocket round-trip latency in milliseconds.",
  buildPayload: () =>
    new SlashCommandBuilder()
      .setName("ping")
      .setDescription("Replies with Pong! and the WebSocket round-trip latency in milliseconds."),
  execute: ({ interaction }) => {
    const pingMs = interaction.client.ws.ping;
    return Promise.resolve(
      interaction.reply({
        content: `Pong! ${pingMs}ms`,
        ephemeral: true,
      }),
    );
  },
};
