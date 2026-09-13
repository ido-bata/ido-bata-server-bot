import { REST } from "discord.js";

import { buildGuildCommandPayloads, guildCommandsRoute } from "./registry.js";

/**
 * Minimal dependencies `deployGuildCommands` needs. The seam mirrors the
 * `HandlerDependencies` pattern from the reaction-role feature so the
 * registration call can be unit-tested without hitting Discord's REST API.
 */
export type DeployDependencies = {
  /**
   * Build the `REST` instance used to talk to Discord. Defaults to a
   * `REST({ version: "10" })` configured with the bot token.
   */
  createRest?: (token: string) => REST;
  /**
   * HTTP-layer entry point. Defaults to `REST#put`. Tests inject a spy.
   */
  send?: (
    rest: REST,
    route: `/${string}`,
    body: ReturnType<typeof buildGuildCommandPayloads>,
  ) => Promise<unknown>;
};

const defaultCreateRest = (token: string): REST => new REST({ version: "10" }).setToken(token);

const defaultSend = async (
  rest: REST,
  route: `/${string}`,
  body: ReturnType<typeof buildGuildCommandPayloads>,
): Promise<unknown> => rest.put(route, { body });

/**
 * Idempotently register every slash command from `slashCommandDefinitions`
 * against the bot's guild. Re-running this with the same definitions is a
 * no-op from Discord's side — `PUT` replaces the existing set wholesale.
 *
 * Throws if `token`, `applicationId`, or `guildId` are missing so the
 * composition root can surface a clear startup error rather than silently
 * shipping an unregistered guild.
 */
export async function deployGuildCommands(
  options: {
    token: string;
    applicationId: string;
    guildId: string;
  },
  deps: DeployDependencies = {},
): Promise<unknown> {
  const { token, applicationId, guildId } = options;

  if (!token || !applicationId || !guildId) {
    throw new Error("deployGuildCommands requires non-empty token, applicationId, and guildId");
  }

  const createRest = deps.createRest ?? defaultCreateRest;
  const send = deps.send ?? defaultSend;
  const rest = createRest(token);
  const route = guildCommandsRoute(applicationId, guildId);
  const body = buildGuildCommandPayloads();

  return send(rest, route, body);
}
