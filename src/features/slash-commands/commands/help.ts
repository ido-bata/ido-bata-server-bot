import { SlashCommandBuilder } from "discord.js";

import type { SlashCommandDefinition } from "../types.js";

export const helpCommand: SlashCommandDefinition = {
  name: "help",
  description: "Lists the slash commands available in this guild.",
  buildPayload: () =>
    new SlashCommandBuilder()
      .setName("help")
      .setDescription("Lists the slash commands available in this guild."),
  execute: async ({ interaction }) => {
    // `interaction.client.application.commands.cache` only mirrors globally
    // registered commands and is not guaranteed to be hydrated after we PUT to
    // `Routes.applicationGuildCommands(...)`. Fetch the guild-scoped manager
    // explicitly so the list reflects what was actually registered to this
    // guild.
    const commands = interaction.guild ? await interaction.guild.commands.fetch() : new Map();

    const lines = Array.from(commands.values())
      .map((command) => `- \`/${command.name}\` — ${command.description}`)
      .sort();

    const body = lines.length > 0 ? lines.join("\n") : "No slash commands are registered yet.";

    return interaction.reply({
      content: body,
      ephemeral: true,
    });
  },
};
