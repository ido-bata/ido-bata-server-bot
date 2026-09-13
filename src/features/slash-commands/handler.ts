import type { Client } from "discord.js";
import { Events } from "discord.js";

import { findSlashCommandDefinition, slashCommandDefinitions } from "./config.js";

/**
 * A minimal slice of `ChatInputCommandInteraction` that the handler needs to
 * drive a reply. Keeping the dependency surface narrow lets tests pass in a
 * hand-rolled fake without touching the real Discord client.
 */
type CommandInteractionLike = {
  commandName: string;
  client: { ws: { ping: number } };
  reply: (options: { content: string; ephemeral: boolean }) => Promise<unknown>;
};

/**
 * Result returned by `dispatchSlashCommand`. Lets the caller (the live client
 * listener and the tests alike) decide whether anything went wrong and how
 * to log it.
 */
export type SlashCommandDispatchResult =
  | { kind: "replied"; commandName: string; content: string }
  | { kind: "unknown"; commandName: string }
  | { kind: "ignored"; reason: "not-chat-input" };

/**
 * Pure-function entry point. Looks up the registered handler for the
 * interaction's `commandName` and either replies, returns `unknown`, or —
 * when called with anything other than a chat-input command — returns
 * `ignored`. The DI seam below lets callers replace the lookup or the reply
 * mechanism (e.g. for tests, or for a future scripted deploy).
 */
export type SlashCommandDependencies = {
  /**
   * Resolve a registered command by name. Defaults to the in-memory registry
   * produced by `config.ts`.
   */
  resolveCommand?: (name: string) => { name: string; description: string } | null;
  /**
   * Read the WebSocket ping. Defaults to `interaction.client.ws.ping`, but
   * tests inject a deterministic value.
   */
  readPing?: (interaction: CommandInteractionLike) => number;
  /**
   * Format the `/help` body. Defaults to a bullet list of registered
   * commands; tests can substitute a sentinel to assert on the value passed
   * to `reply`.
   */
  formatHelp?: (commands: { name: string; description: string }[]) => string;
  /**
   * Actually send the reply. Defaults to `interaction.reply(...)`. Tests
   * swap this for a spy.
   */
  reply?: (interaction: CommandInteractionLike, content: string) => Promise<unknown>;
};

const defaultResolveCommand = (name: string) => findSlashCommandDefinition(name);

const defaultReadPing = (interaction: CommandInteractionLike) => interaction.client.ws.ping;

const defaultFormatHelp = (commands: { name: string; description: string }[]): string => {
  if (commands.length === 0) {
    return "No slash commands registered.";
  }

  const lines = commands.map((command) => `- \`/${command.name}\` — ${command.description}`);
  return `Registered slash commands:\n${lines.join("\n")}`;
};

const defaultReply = async (
  interaction: CommandInteractionLike,
  content: string,
): Promise<unknown> => interaction.reply({ content, ephemeral: true });

/**
 * Build the handler object. The closure keeps the (possibly overridden)
 * dependencies in scope without leaking them onto `Client`.
 */
export function createSlashCommandHandler(deps: SlashCommandDependencies = {}) {
  const resolveCommand = deps.resolveCommand ?? defaultResolveCommand;
  const readPing = deps.readPing ?? defaultReadPing;
  const formatHelp = deps.formatHelp ?? defaultFormatHelp;
  const reply = deps.reply ?? defaultReply;

  async function dispatch(
    interaction: CommandInteractionLike,
  ): Promise<SlashCommandDispatchResult> {
    const command = resolveCommand(interaction.commandName);

    if (!command) {
      await reply(interaction, "unknown command");
      return { kind: "unknown", commandName: interaction.commandName };
    }

    let content: string;

    if (interaction.commandName === "ping") {
      const latencyMs = Math.round(readPing(interaction));
      content = `Pong! ${latencyMs}ms`;
    } else if (interaction.commandName === "help") {
      content = formatHelp(slashCommandDefinitions);
    } else {
      // Future commands land here; the current scaffold only registers ping
      // and help, so we should never see anything else. Guard anyway so a
      // buggy registry does not silently drop a reply.
      content = `\`/${command.name}\` is registered but has no handler.`;
    }

    await reply(interaction, content);
    return { kind: "replied", commandName: command.name, content };
  }

  return { dispatch };
}

export type SlashCommandHandler = ReturnType<typeof createSlashCommandHandler>;

/**
 * Register the `Events.InteractionCreate` listener on a real Discord
 * `Client`. Only chat-input command interactions are forwarded; component /
 * autocomplete / modal events stay with their respective features.
 */
export function registerSlashCommandHandlers(client: Client): SlashCommandHandler {
  const handler = createSlashCommandHandler();

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    // Cast the discord.js interaction into the narrow shape the handler
    // expects. The structural subset (`commandName`, `client.ws.ping`,
    // `reply`) is guaranteed by the chat-input interaction contract.
    const narrow = interaction as unknown as CommandInteractionLike;
    await handler.dispatch(narrow);
  });

  return handler;
}
