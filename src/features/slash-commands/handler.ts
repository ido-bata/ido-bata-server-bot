import type { Client } from "discord.js";
import { Events } from "discord.js";

import { handlePrivacyButton, type PrivacyCommandDeps } from "./commands/privacy.js";
import { createSlashCommandRegistry, type SlashCommandRegistry } from "./registry.js";
import type { SlashCommandDefinition } from "./types.js";

/**
 * Subset of `Discord.Interaction` we need to route between chat-input
 * commands and button click handlers. Kept narrow so tests can fake the
 * minimum surface (chat input vs button customId + isButton check).
 *
 * `isButton` is optional because older test stubs built against the
 * pre-button dispatcher did not provide it. When absent we treat the
 * interaction as a chat input candidate — same behavior as before.
 */
type InteractionLike = {
  isChatInputCommand: () => boolean;
  isButton?: () => boolean;
  isRepliable: () => boolean;
  commandName: string;
  customId: string;
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
  /**
   * Per-command runtime deps. The privacy command consumes
   * `PrivacyCommandDeps.consentService` and
   * `PrivacyCommandDeps.takeFreshSnapshot`; other commands currently ignore
   * the object. The dispatcher forwards the whole object so the
   * contract is uniform.
   */
  commandDeps?: { privacy?: PrivacyCommandDeps };
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

    // Per-command deps lookup. New commands extend this map without
    // touching the dispatcher. Commands that don't need runtime deps
    // just ignore the second arg.
    const commandDeps = deps.commandDeps?.privacy;

    await definition.execute(
      {
        interaction: interaction as never,
        commandName: interaction.commandName,
      },
      // Cast: SlashCommandDefinition.execute is typed with only the
      // context arg for backwards compatibility. The privacy command
      // accepts the second `deps` arg at runtime.
      commandDeps as never,
    );
  }

  async function handleButton(interaction: InteractionLike): Promise<void> {
    // The privacy command owns the only currently-registered button
    // customIds (`privacy:delete:confirm:*` and `privacy:delete:cancel:*`).
    // Route those to `handlePrivacyButton` so the Confirm/Cancel buttons
    // actually mutate state instead of being dropped by the dispatcher.
    if (interaction.customId.startsWith("privacy:delete:")) {
      await handlePrivacyButton(
        interaction as never,
        // PrivacyCommandDeps wires the consent service; forward it so the
        // Confirm path can also call `ConsentService.clear()`.
        (deps.commandDeps?.privacy ?? {}) as never,
      );
      return;
    }
    // Unknown button — ignore silently. The dispatcher must never ack a
    // customId it doesn't own; doing so would silently consume other
    // features' button presses.
  }

  return {
    registry,
    definitions: registry.definitions as SlashCommandDefinition[],
    handleInteraction: async (raw: unknown) => {
      const resolve = deps.resolveInteraction ?? ((value: unknown) => value as InteractionLike);
      const interaction = resolve(raw);
      if (!interaction) {
        return;
      }
      // Order matters: button interactions do NOT satisfy
      // `isChatInputCommand()`, so the previous `if (!chat input) return`
      // short-circuit dropped them on the floor. We dispatch buttons
      // first, then chat input.
      if (interaction.isButton?.()) {
        await handleButton(interaction);
        return;
      }
      if (!interaction.isChatInputCommand()) {
        return;
      }
      await dispatch(interaction);
    },
  };
}

export function registerSlashCommandHandlers(
  client: Client,
  deps: { commandDeps?: HandlerDependencies["commandDeps"] } = {},
): void {
  const handler = createSlashCommandHandler({ commandDeps: deps.commandDeps });

  client.on(Events.InteractionCreate, async (interaction) => {
    await handler.handleInteraction(interaction);
  });
}
