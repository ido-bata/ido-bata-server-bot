import type { REST, RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";
import { REST as RestClass, Routes, SlashCommandBuilder } from "discord.js";

import { resolveSlashPermissionLevel } from "../slash-permissions/config.js";
import { applyDefaultMemberPermissions } from "../slash-permissions/runtime.js";
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

  const payload = deps.registry.definitions.map((definition: SlashCommandDefinition) => {
    const base = toApplicationCommandPayload(definition.buildPayload());
    // Apply `default_member_permissions` so Discord enforces the same tier
    // everywhere the rule map declares. Without this, the GUI permission
    // map stays internal-only and the deployed command ends up with no
    // restriction regardless of the project's policy.
    const level = resolveSlashPermissionLevel(definition.name);
    return applyDefaultMemberPermissions(
      base as unknown as Record<string, unknown>,
      level,
    ) as unknown as RESTPostAPIChatInputApplicationCommandsJSONBody & {
      default_member_permissions: string;
    };
  });

  const rest = deps.rest ?? new RestClass({ version: "10" }).setToken(deps.token);

  await rest.put(Routes.applicationGuildCommands(deps.clientId, deps.guildId), {
    body: payload,
  });

  return { registered: payload.length };
}
