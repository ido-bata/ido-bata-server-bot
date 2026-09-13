import type { Client } from "discord.js";
import { Events, PermissionsBitField } from "discord.js";

import {
  TimekeeperCommandError,
  type TimekeeperCommandsDependencies,
  type TimekeeperSubcommandName,
  timekeeperSubcommandHandlers,
} from "./commands.js";

/**
 * Structural type covering everything the dispatcher needs from a Discord
 * chat-input interaction. Kept narrow so tests can construct fakes
 * without touching the real Client. The real `ChatInputCommandInteraction`
 * from `discord.js` satisfies this shape verbatim.
 */
type TimekeeperChatInputInteraction = {
  isChatInputCommand: () => boolean;
  isRepliable: () => boolean;
  commandName: string;
  options: {
    getSubcommand: (required: boolean) => string;
  };
  memberPermissions: { has: (flag: bigint) => boolean } | null;
  user: { id: string };
  reply: (options: { content: string; ephemeral?: boolean }) => Promise<unknown>;
};

type TimekeeperHandlerDependencies = {
  /**
   * Build the command-time dependency bundle (moderator role gate, etc.).
   * Defaults to a permission-bit check on the interaction itself; callers
   * that have configured a real moderator role should pass a closure that
   * inspects the member's role cache.
   */
  buildDependencies?: (
    interaction: TimekeeperChatInputInteraction,
  ) => TimekeeperCommandsDependencies;
};

type InteractionResolve = (raw: unknown) => TimekeeperChatInputInteraction | null;

const TIMEKEEPER_COMMAND_NAME = "timekeeper";

export function createTimekeeperCommandHandler(deps: TimekeeperHandlerDependencies = {}) {
  async function dispatch(rawInteraction: unknown, resolve: InteractionResolve): Promise<void> {
    const interaction = resolve(rawInteraction);
    if (!interaction) {
      return;
    }

    if (!interaction.isChatInputCommand() || interaction.commandName !== TIMEKEEPER_COMMAND_NAME) {
      return;
    }

    const subcommand = interaction.options.getSubcommand(false) as TimekeeperSubcommandName;
    const handler = timekeeperSubcommandHandlers[subcommand];

    if (!handler) {
      if (interaction.isRepliable()) {
        await interaction.reply({
          content: `unknown subcommand: ${subcommand}`,
          ephemeral: true,
        });
      }
      return;
    }

    const commandDeps = deps.buildDependencies?.(interaction) ?? defaultDependencies(interaction);
    try {
      const result = handler(commandDeps);
      if (interaction.isRepliable()) {
        await interaction.reply(result);
      }
    } catch (error: unknown) {
      if (interaction.isRepliable()) {
        await interaction.reply(errorToReply(error));
      }
    }
  }

  return {
    commandName: TIMEKEEPER_COMMAND_NAME,
    handleInteraction: async (raw: unknown, customResolve?: InteractionResolve) => {
      const resolve: InteractionResolve =
        customResolve ?? ((value: unknown) => value as TimekeeperChatInputInteraction | null);
      await dispatch(raw, resolve);
    },
  };
}

/**
 * Default permission gate: when no moderator role is configured in
 * `config.ts`, gate on the `Administrator` permission bit. When a real
 * role is configured, the composition root must install a
 * `buildDependencies` that fetches the member's role cache.
 */
function defaultDependencies(
  interaction: TimekeeperChatInputInteraction,
): TimekeeperCommandsDependencies {
  const isAdmin =
    interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator) ?? false;
  return {
    moderatorRoleId: "",
    hasModeratorRole: isAdmin,
  };
}

function errorToReply(error: unknown): { content: string; ephemeral: true } {
  if (error instanceof TimekeeperCommandError) {
    return { content: error.message, ephemeral: true };
  }
  if (error instanceof Error) {
    return { content: error.message, ephemeral: true };
  }
  return { content: "internal error", ephemeral: true };
}

export function registerTimekeeperCommandHandlers(client: Client): void {
  const handler = createTimekeeperCommandHandler();

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }
    await handler.handleInteraction(interaction);
  });
}

export type { TimekeeperChatInputInteraction };
