import type { Client, TextChannel } from "discord.js";
import { ChannelType, Events } from "discord.js";

import { type GitHubWebhookConfig, readGitHubWebhookConfig } from "./config.js";
import { type GitHubWebhookServerHandle, createGitHubWebhookServer } from "./server.js";

export type { GitHubWebhookConfig } from "./config.js";
export { readGitHubWebhookConfig } from "./config.js";

export type { GitHubWebhookServerHandle } from "./server.js";

export type RegisterGitHubWebhookOptions = {
  /** Override the parsed env config. */
  config?: GitHubWebhookConfig;
  /** Disable the HTTP server. Useful for unit tests. */
  disableServer?: boolean;
};

export type GitHubWebhookRegistration = {
  config: GitHubWebhookConfig;
  handle: GitHubWebhookServerHandle | null;
};

/**
 * Wire the GitHub webhook feature into the bot process.
 *
 * Spins up a minimal HTTP server (the same pattern used by the health /
 * metrics server in #26) that:
 *
 * - Verifies `X-Hub-Signature-256` against `GITHUB_WEBHOOK_SECRET`
 * - Filters by `GITHUB_WEBHOOK_EVENTS` (default: release.published,
 *   pull_request.closed/merged, issues.opened)
 * - Applies a 60-second per-repo rate limit
 * - Posts the rendered Discord embed into `GITHUB_WEBHOOK_DISCORD_CHANNEL_ID`
 *
 * The Discord client is used only to resolve the configured channel and
 * post messages. If the bot is not ready yet, deliveries are skipped
 * (the rate-limit window keeps the situation from spiralling).
 */
export async function registerGitHubWebhook(
  client: Client,
  options: RegisterGitHubWebhookOptions = {},
): Promise<GitHubWebhookRegistration> {
  const config = options.config ?? readGitHubWebhookConfig(process.env);

  let handle: GitHubWebhookServerHandle | null = null;

  if (!options.disableServer) {
    handle = await createGitHubWebhookServer({
      host: config.host,
      port: config.port,
      secret: config.secret,
      allowedEvents: config.allowedEvents,
      defaultDiscordChannelId: config.discordChannelId,
      deliver: (channelId, message) => deliverToChannel(client, channelId, message),
    });
    console.log(`GitHub webhook server listening on http://${config.host}:${handle.port}`);
  }

  return { config, handle };
}

async function deliverToChannel(
  client: Client,
  channelId: string,
  message: { embeds: unknown[] },
): Promise<void> {
  const channel = await client.channels.fetch(channelId);

  if (!channel) {
    throw new Error(`Discord channel not found: ${channelId}`);
  }

  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
    throw new Error(`Channel ${channelId} is not a text or announcement channel`);
  }

  const textChannel = channel as unknown as TextChannel;
  await textChannel.send({ embeds: message.embeds as never });
}

// Surface a minimal Discord-ready listener so future features can react to
// webhook deliveries (e.g. analytics). Currently unused but exported for
// symmetry with other features.
export function attachGitHubWebhookLogging(
  client: Client,
  handle: GitHubWebhookServerHandle,
): void {
  client.on(Events.ClientReady, () => {
    console.log(
      `GitHub webhook ready: ${handle.port > 0 ? `http://127.0.0.1:${handle.port}/webhook/github` : "disabled"}`,
    );
  });
}