import { type RESTPostAPIChatInputApplicationCommandsJSONBody, Routes } from "discord.js";

import { slashCommandDefinitions } from "./config.js";

/**
 * The Discord REST payload that PUTs/POSTs to the application guild command
 * endpoint accept. We use the chat-input JSON shape because both `/ping` and
 * `/help` are chat-input commands.
 */
export type GuildCommandPayload = RESTPostAPIChatInputApplicationCommandsJSONBody;

/**
 * Render every registered command into the JSON body the Discord REST API
 * expects. The shape is what `SlashCommandBuilder#toJSON()` produces — pinned
 * by the snapshot test so Discord API contract changes are caught early.
 */
export function buildGuildCommandPayloads(): GuildCommandPayload[] {
  return slashCommandDefinitions.map((definition) => definition.build().toJSON());
}

/**
 * The route passed to `REST#put(...)`. Exposed as a tiny helper so the deploy
 * script and the tests share a single source of truth for the URL.
 */
export function guildCommandsRoute(applicationId: string, guildId: string): `/${string}` {
  // `Routes.applicationGuildCommands` returns a template-literal string
  // whose leading `/` is part of the Discord REST contract — `REST#put`
  // accepts it verbatim.
  return Routes.applicationGuildCommands(applicationId, guildId) as `/${string}`;
}
