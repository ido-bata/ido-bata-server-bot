import type { Client, TextChannel } from "discord.js";
import { ChannelType } from "discord.js";

import type { HttpRouter } from "../../http/router.js";
import { type GitHubWebhookConfig, readGitHubWebhookConfig } from "./config.js";
import { registerWebhookRoutes, type WebhookRouteHandle } from "./server.js";

export type RegisterGitHubWebhookOptions = {
  /** Override the parsed env config. */
  config?: GitHubWebhookConfig;
  /**
   * Inject the shared router (typically owned by the composition root in
   * `src/index.ts`). When omitted, `registerGitHubWebhook` registers the
   * route on a fresh router but does NOT bind a TCP listener — callers
   * are expected to drive the lifecycle themselves (the test suite uses
   * this seam to exercise the route handler without binding a port).
   */
  router?: HttpRouter;
};

export type GitHubWebhookRegistration = {
  config: GitHubWebhookConfig;
  /** Always populated when `router` is supplied; useful for sharing rate-limit state. */
  route: WebhookRouteHandle | null;
};

/**
 * Wire the GitHub webhook feature into the bot process.
 *
 * Registers `/webhook/github` on the shared HTTP router so the webhook
 * shares the same TCP port as `/health` and `/metrics` from issue #26
 * (issue #36 acceptance criterion). The actual listener is owned by the
 * composition root in `src/index.ts`.
 *
 * - Verifies `X-Hub-Signature-256` against `GITHUB_WEBHOOK_SECRET`
 * - Filters by `GITHUB_WEBHOOK_EVENTS` (default: release.published,
 *   pull_request.closed/merged, issues.opened)
 * - Applies a 60-second per-repo rate limit
 * - Posts the rendered Discord embed into `GITHUB_WEBHOOK_DISCORD_CHANNEL_ID`
 *
 * The Discord client is used only to resolve the configured channel and
 * post messages.
 */
export function registerGitHubWebhook(
  client: Client,
  options: RegisterGitHubWebhookOptions = {},
): GitHubWebhookRegistration {
  const config = options.config ?? readGitHubWebhookConfig(process.env);

  let route: WebhookRouteHandle | null = null;

  if (options.router) {
    route = registerWebhookRoutes(options.router, {
      host: config.host,
      port: config.port,
      secret: config.secret,
      allowedEvents: config.allowedEvents,
      defaultDiscordChannelId: config.discordChannelId,
      deliver: (channelId, message) => deliverToChannel(client, channelId, message),
    });
  }

  return { config, route };
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
