// REST deployer for the birthday slash command. Mirrors the minimal shape
// used by slash-commands base (#13) so the future migration is mechanical.

import type { REST, RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";
import type { SlashCommandSubcommandsOnlyBuilder } from "discord.js";
import { REST as RestClass, Routes, SlashCommandBuilder } from "discord.js";

import type { BirthdayCommandDefinition, BirthdayCommandRegistry } from "./commands.js";

export type DeployBirthdayCommandsDeps = {
  registry: BirthdayCommandRegistry;
  token: string;
  clientId: string;
  guildId: string;
  rest?: Pick<REST, "put">;
};

export type DeployBirthdayCommandsResult = {
  registered: number;
};

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

export async function deployBirthdayCommands(
  deps: DeployBirthdayCommandsDeps,
): Promise<DeployBirthdayCommandsResult> {
  if (!deps.token) throw new Error("deployBirthdayCommands: token is required");
  if (!deps.clientId) throw new Error("deployBirthdayCommands: clientId is required");
  if (!deps.guildId) throw new Error("deployBirthdayCommands: guildId is required");

  const payload = deps.registry.definitions.map((definition: BirthdayCommandDefinition) =>
    toApplicationCommandPayload(definition.buildPayload()),
  );

  const rest = deps.rest ?? new RestClass({ version: "10" }).setToken(deps.token);
  await rest.put(Routes.applicationGuildCommands(deps.clientId, deps.guildId), { body: payload });

  return { registered: payload.length };
}
