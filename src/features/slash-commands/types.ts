import type {
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
  SlashCommandBuilder,
} from "discord.js";

/**
 * Runtime deps the dispatcher forwards to a command's `execute`. Each
 * command picks the subset it needs and ignores the rest; the union type
 * keeps the dispatcher from needing per-command switch logic.
 *
 * `SlashCommandDeps` was deleted in v0.2.0 round-5 cleanup: the
 * dispatcher forwards `unknown` to commands, so no typed wrapper was
 * needed and Knip flagged the unused export.
 */
export type SlashCommandDefinition = {
  // Stable id used both as the registration payload name and the dispatch key.
  name: string;
  description: string;
  // Produces the Discord REST payload. Accepts either a raw payload object or
  // a builder that exposes `toJSON()` (e.g. `SlashCommandBuilder`).
  buildPayload: () => RESTPostAPIChatInputApplicationCommandsJSONBody | SlashCommandBuilder;
  /**
   * Executes against a real interaction. Pure for inputs, but side-effects are
   * funneled through the reply helper (see `HandlerDependencies`).
   *
   * The optional second argument is the command-specific runtime deps
   * (e.g. `ConsentService` for `/privacy`). The dispatcher forwards it
   * verbatim; commands that don't need it simply ignore it.
   */
  execute: (
    context: { interaction: ChatInputCommandInteraction; commandName: string },
    deps?: unknown,
  ) => Promise<unknown> | unknown;
};

export type SlashCommandRegistry = {
  definitions: SlashCommandDefinition[];
  find: (name: string) => SlashCommandDefinition | undefined;
};
