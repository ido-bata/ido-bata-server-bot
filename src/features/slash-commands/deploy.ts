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

/**
 * Build the JSON payload for the slash-command registry. Used in the
 * aggregated `deployGuildCommands` path so the slash deployer does not
 * issue an independent bulk PUT (which would race with the other
 * per-feature deployers and overwrite each other — see PR review VJn3).
 */
export function buildSlashCommandPayloads(
  registry: SlashCommandRegistry,
): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return registry.definitions.map((definition: SlashCommandDefinition) => {
    const base = toApplicationCommandPayload(definition.buildPayload());
    // Apply `default_member_permissions` so Discord enforces the same tier
    // everywhere the rule map declares. `everyone`-level commands omit the
    // field; everyone else carries a stringified bit. See PR review VK2V.
    const level = resolveSlashPermissionLevel(definition.name);
    return applyDefaultMemberPermissions(
      base as unknown as Record<string, unknown>,
      level,
    ) as unknown as RESTPostAPIChatInputApplicationCommandsJSONBody;
  });
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

  const payload = buildSlashCommandPayloads(deps.registry);

  const rest = deps.rest ?? new RestClass({ version: "10" }).setToken(deps.token);

  await rest.put(Routes.applicationGuildCommands(deps.clientId, deps.guildId), {
    body: payload,
  });

  return { registered: payload.length };
}
