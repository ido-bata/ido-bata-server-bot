import { SlashCommandBuilder } from "discord.js";

/**
 * A slash command definition. The `name` doubles as the dispatch key the
 * handler looks up at `InteractionCreate` time, so it must match
 * `SlashCommandBuilder#setName(...)` exactly.
 */
export type SlashCommandDefinition = {
  name: string;
  description: string;
  build: () => SlashCommandBuilder;
};

/**
 * Minimum set of commands for the slash-commands scaffold.
 *
 * `/ping` reports the WebSocket ping back to the invoker as ephemeral.
 * `/help` lists the registered command names with their one-line
 * descriptions, also ephemeral.
 *
 * Each definition is exported as a builder function so tests can assert the
 * resulting `SlashCommandBuilder#toJSON()` payload without mutating module
 * state.
 */
export const slashCommandDefinitions: SlashCommandDefinition[] = [
  {
    name: "ping",
    description: "Check the bot's WebSocket round-trip latency.",
    build: () =>
      new SlashCommandBuilder().setName("ping").setDescription("Reply with Pong and latency."),
  },
  {
    name: "help",
    description: "List the registered slash commands with their descriptions.",
    build: () =>
      new SlashCommandBuilder()
        .setName("help")
        .setDescription("Show the list of available slash commands."),
  },
];

export function findSlashCommandDefinition(name: string): SlashCommandDefinition | null {
  return slashCommandDefinitions.find((definition) => definition.name === name) ?? null;
}
