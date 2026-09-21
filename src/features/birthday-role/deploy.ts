// REST payload builder for the birthday-role slash commands.
//
// The aggregated `deployGuildCommands` path in `src/index.ts` consumes the
// JSON payloads produced here, so the birthday deployer does NOT
// independently bulk-PUT `Routes.applicationGuildCommands` (which would
// race with the other deployers and overwrite them — PR review VJn3).
// Earlier revisions exposed `deployBirthdayCommands` directly; that
// function was deleted in v0.2.0 round-5 cleanup because nothing wired it
// after the aggregator landed.

import type {
  RESTPostAPIChatInputApplicationCommandsJSONBody,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import { SlashCommandBuilder } from "discord.js";

import type { BirthdayCommandDefinition, BirthdayCommandRegistry } from "./commands.js";

export function toApplicationCommandPayload(
  value:
    | RESTPostAPIChatInputApplicationCommandsJSONBody
    | SlashCommandBuilder
    | SlashCommandSubcommandsOnlyBuilder,
): RESTPostAPIChatInputApplicationCommandsJSONBody {
  if (value instanceof SlashCommandBuilder) {
    return value.toJSON();
  }
  return value as RESTPostAPIChatInputApplicationCommandsJSONBody;
}

/**
 * Build the JSON payload for the birthday-role registry. Used by the
 * aggregated `deployGuildCommands` path in `src/index.ts` so the
 * birthday deployer does not independently bulk-PUT
 * `Routes.applicationGuildCommands` and race with the other deployers
 * (PR review VJn3 sibling).
 */
export function buildBirthdayPayloads(
  registry: BirthdayCommandRegistry,
): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return registry.definitions.map((definition: BirthdayCommandDefinition) =>
    toApplicationCommandPayload(definition.buildPayload()),
  );
}
