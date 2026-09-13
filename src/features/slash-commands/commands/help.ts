import { SlashCommandBuilder } from "discord.js";

import type { SlashCommandDefinition } from "../types.js";

export const helpCommand: SlashCommandDefinition = {
  name: "help",
  description: "Lists the slash commands available in this guild.",
  buildPayload: () =>
    new SlashCommandBuilder()
      .setName("help")
      .setDescription("Lists the slash commands available in this guild."),
  execute: ({ interaction }) => {
    const lines = interaction.client.application?.commands.cache
      ? Array.from(interaction.client.application.commands.cache.values())
          .map((command) => `- \`/${command.name}\` — ${command.description}`)
          .sort()
      : [];

    const body = lines.length > 0 ? lines.join("\n") : "No slash commands are registered yet.";

    return Promise.resolve(
      interaction.reply({
        content: body,
        ephemeral: true,
      }),
    );
  },
};
