import type { Client, ChatInputCommandInteraction } from "discord.js";
import { Events } from "discord.js";

import { runRoleAssignment, replyForResult } from "./commands.js";
import { createRoleSlashCommandRegistry, type SlashCommandRegistry } from "./registry.js";
import type { RoleAction, RoleAssignmentDependencies } from "./types.js";

type InteractionLike = {
  isChatInputCommand: () => boolean;
  isRepliable: () => boolean;
  commandName: string;
  reply: (options: { content: string; ephemeral?: boolean }) => Promise<unknown>;
  user: { id: string };
  guildId: string;
  client?: unknown;
  options: {
    getSubcommand: () => string;
    get: (name: string, required: boolean) => { value?: string } | null;
  };
};

type RoleCommandExecuteContext = {
  interaction: ChatInputCommandInteraction;
  commandName: string;
};

type HandlerDependencies = RoleAssignmentDependencies & {
  registry?: SlashCommandRegistry;
  // Lets tests inject a fake interaction without touching the live Client.
  resolveInteraction?: (raw: unknown) => InteractionLike | null;
};

// Builds the execute function that the role definition will use. Each call
// uses the provided dependency seams so tests can wire fakes for permission
// checks, role lookup, member fetch, and audit logging.
function buildRoleExecute(deps: HandlerDependencies) {
  return async ({ interaction }: RoleCommandExecuteContext): Promise<unknown> => {
    // commandName is the top-level name (`role`); the subcommand encodes the
    // intent. Anything other than `assign` falls back to `remove` for safety.
    const sub = (interaction as unknown as InteractionLike).options.getSubcommand();
    const action: RoleAction = sub === "assign" ? "assign" : "remove";
    const result = await runRoleAssignment(interaction as unknown, action, deps);
    const roleId =
      (interaction as unknown as InteractionLike).options.get("role", true)?.value ?? "";
    return interaction.reply(replyForResult(result, roleId));
  };
}

export function createRoleSlashHandler(deps: HandlerDependencies = {}) {
  const registry = deps.registry ?? createRoleSlashCommandRegistry();

  // Re-bind the role definition's execute to use the provided dependencies.
  const definitionWithDeps = {
    ...registry.definitions[0],
    execute: buildRoleExecute(deps),
  } as (typeof registry.definitions)[number];
  const definitions =
    registry.definitions.length > 0
      ? [definitionWithDeps, ...registry.definitions.slice(1)]
      : registry.definitions;

  async function dispatch(interaction: InteractionLike): Promise<void> {
    const definition = definitions.find((entry) => entry.name === interaction.commandName);

    if (!definition) {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: "unknown command", ephemeral: true });
      }
      return;
    }

    await definition.execute({
      interaction: interaction as unknown as ChatInputCommandInteraction,
      commandName: interaction.commandName,
    });
  }

  return {
    registry: { ...registry, definitions },
    handleInteraction: async (raw: unknown) => {
      const resolve = deps.resolveInteraction ?? ((value: unknown) => value as InteractionLike);
      const interaction = resolve(raw);

      if (!interaction?.isChatInputCommand()) {
        return;
      }

      await dispatch(interaction);
    },
    definitions,
  };
}

export function registerRoleSlashHandlers(client: Client): void {
  const handler = createRoleSlashHandler();

  client.on(Events.InteractionCreate, async (interaction) => {
    await handler.handleInteraction(interaction);
  });
}