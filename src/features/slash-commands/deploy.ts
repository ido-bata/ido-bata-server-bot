import type { REST, RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";
import { REST as RestClass, Routes, SlashCommandBuilder } from "discord.js";

import type { SlashCommandDefinition, SlashCommandRegistry } from "./types.js";

export type DeployCommandsResult = {
  registered: number;
};

export type DeployCommandsDeps = {
  registry: SlashCommandRegistry;
  token: string;
  clientId: string;
  guildId: string;
  // Lets tests substitute a fake REST client.
  rest?: Pick<REST, "put">;
};

export function toApplicationCommandPayload(
  value: RESTPostAPIChatInputApplicationCommandsJSONBody | SlashCommandBuilder,
): RESTPostAPIChatInputApplicationCommandsJSONBody {
  if (value instanceof SlashCommandBuilder) {
    return value.toJSON();
  }

  return value;
}

export async function deploySlashCommands(deps: DeployCommandsDeps): Promise<DeployCommandsResult> {
  if (!deps.token) {
    throw new Error("deploySlashCommands: token is required");
  }
  if (!deps.clientId) {
    throw new Error("deploySlashCommands: clientId is required");
  }
  if (!deps.guildId) {
    throw new Error("deploySlashCommands: guildId is required");
  }

  const payload = deps.registry.definitions.map((definition: SlashCommandDefinition) =>
    toApplicationCommandPayload(definition.buildPayload()),
  );

  const rest = deps.rest ?? new RestClass({ version: "10" }).setToken(deps.token);

  await rest.put(Routes.applicationGuildCommands(deps.clientId, deps.guildId), {
    body: payload,
  });

  return { registered: payload.length };
}
