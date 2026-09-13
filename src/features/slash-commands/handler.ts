import type { Client } from "discord.js";
import { Events } from "discord.js";

import { createSlashCommandRegistry, type SlashCommandRegistry } from "./registry.js";
import type { SlashCommandDefinition } from "./types.js";

type InteractionLike = {
  isChatInputCommand: () => boolean;
  isRepliable: () => boolean;
  commandName: string;
  reply: (options: { content: string; ephemeral?: boolean }) => Promise<unknown>;
  user: { id: string };
  client: Client;
};

type HandlerDependencies = {
  registry?: SlashCommandRegistry;
  // Lets tests inject an `InteractionLike` without touching the live Client.
  resolveInteraction?: (raw: unknown) => InteractionLike | null;
  // Lets tests inject a custom Client without spinning up Discord.
  client?: Client;
};

export function createSlashCommandHandler(deps: HandlerDependencies = {}) {
  const registry = deps.registry ?? createSlashCommandRegistry();

  async function dispatch(interaction: InteractionLike): Promise<void> {
    const definition = registry.find(interaction.commandName);

    if (!definition) {
      if (interaction.isRepliable()) {
        await interaction.reply({
          content: "unknown command",
          ephemeral: true,
        });
      }
      return;
    }

    await definition.execute({
      interaction: interaction as never,
      commandName: interaction.commandName,
    });
  }

  return {
    registry,
    definitions: registry.definitions as SlashCommandDefinition[],
    handleInteraction: async (raw: unknown) => {
      const resolve = deps.resolveInteraction ?? ((value: unknown) => value as InteractionLike);
      const interaction = resolve(raw);

      if (!interaction?.isChatInputCommand()) {
        return;
      }

      await dispatch(interaction);
    },
  };
}

export function registerSlashCommandHandlers(client: Client): void {
  const handler = createSlashCommandHandler();

  client.on(Events.InteractionCreate, async (interaction) => {
    await handler.handleInteraction(interaction);
  });
}
