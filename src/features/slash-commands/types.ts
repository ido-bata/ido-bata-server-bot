import type {
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
  SlashCommandBuilder,
} from "discord.js";

export type SlashCommandDefinition = {
  // Stable id used both as the registration payload name and the dispatch key.
  name: string;
  description: string;
  // Produces the Discord REST payload. Accepts either a raw payload object or
  // a builder that exposes `toJSON()` (e.g. `SlashCommandBuilder`).
  buildPayload: () => RESTPostAPIChatInputApplicationCommandsJSONBody | SlashCommandBuilder;
  // Executes against a real interaction. Pure for inputs, but side-effects are
  // funneled through the reply helper (see `HandlerDependencies`).
  execute: (context: {
    interaction: ChatInputCommandInteraction;
    commandName: string;
  }) => Promise<unknown> | unknown;
};

export type SlashCommandRegistry = {
  definitions: SlashCommandDefinition[];
  find: (name: string) => SlashCommandDefinition | undefined;
};
