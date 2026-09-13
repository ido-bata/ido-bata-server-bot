import type { REST, RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";
import { REST as RestClass, Routes, SlashCommandBuilder } from "discord.js";

import type { SlashCommandDefinition, SlashCommandRegistry, ToJSONCapable } from "./types.js";

export type DeployRoleCommandsResult = {
  registered: number;
};

export type DeployRoleCommandsDeps = {
  registry: SlashCommandRegistry;
  token: string;
  clientId: string;
  guildId: string;
  // Lets tests substitute a fake REST client.
  rest?: Pick<REST, "put">;
};

export function toApplicationCommandPayload(
  value: RESTPostAPIChatInputApplicationCommandsJSONBody | ToJSONCapable,
): RESTPostAPIChatInputApplicationCommandsJSONBody {
  if (value instanceof SlashCommandBuilder) {
    return value.toJSON();
  }

  const maybeWithToJSON = value as { toJSON?: unknown };
  if (typeof maybeWithToJSON.toJSON === "function") {
    return (value as ToJSONCapable).toJSON();
  }

  return value as RESTPostAPIChatInputApplicationCommandsJSONBody;
}

export async function deployRoleSlashCommands(
  deps: DeployRoleCommandsDeps,
): Promise<DeployRoleCommandsResult> {
  if (!deps.token) {
    throw new Error("deployRoleSlashCommands: token is required");
  }
  if (!deps.clientId) {
    throw new Error("deployRoleSlashCommands: clientId is required");
  }
  if (!deps.guildId) {
    throw new Error("deployRoleSlashCommands: guildId is required");
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