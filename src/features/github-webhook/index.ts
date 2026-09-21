import type { Client, TextChannel } from "discord.js";
import { ChannelType } from "discord.js";

import type { HttpRouter } from "../../http/router.js";
import { type GitHubWebhookConfig, readGitHubWebhookConfig } from "./config.js";
import {
  createGitHubWebhookServer,
  type GitHubWebhookServerHandle,
  registerWebhookRoutes,
  type WebhookRouteHandle,
} from "./server.js";

export type RegisterGitHubWebhookOptions = {
  /** Override the parsed env config. */
  config?: GitHubWebhookConfig;
  /**
   * Inject the shared router (typically owned by the composition root in
   * `src/index.ts`). When omitted, `registerGitHubWebhook` spins up its
   * own dedicated listener via `createGitHubWebhookServer` so the route
   * is actually reachable. Tests pass a router (often on an ephemeral
   * port) to drive the handler without a TCP listener.
   */
  router?: HttpRouter;
};

export type GitHubWebhookRegistration = {
  config: GitHubWebhookConfig;
  /** Always populated; useful for sharing rate-limit state. */
  route: WebhookRouteHandle | null;
  /**
   * Populated only when `router` was omitted. The composition root owns
   * the lifecycle of this server (typically bound to the lifecycle hooks
   * registered by `registerShutdownHandler`).
   */
  server?: GitHubWebhookServerHandle;
};

/**
 * Wire the GitHub webhook feature into the bot process.
 *
 * Registers `/webhook/github` on the shared HTTP router (when one is
 * provided) so the webhook shares the same TCP port as `/health` and
 * `/metrics` from issue #26. When no router is supplied — the production
 * call from `src/index.ts` — `registerGitHubWebhook` spins up its own
 * listener via `createGitHubWebhookServer` so the route is reachable.
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
export async function registerGitHubWebhook(
  client: Client,
  options: RegisterGitHubWebhookOptions = {},
): Promise<GitHubWebhookRegistration> {
  const config = options.config ?? readGitHubWebhookConfig(process.env);

  if (options.router) {
    const route = registerWebhookRoutes(options.router, {
      host: config.host,
      port: config.port,
      secret: config.secret,
      allowedEvents: config.allowedEvents,
      defaultDiscordChannelId: config.discordChannelId,
      deliver: (channelId, message) => deliverToChannel(client, channelId, message),
    });
    return { config, route };
  }

  // No shared router: bind a dedicated server so the webhook actually
  // becomes reachable. The previous implementation silently skipped this
  // branch, leaving `/webhook/github` unregistered in production.
  const server = await createGitHubWebhookServer({
    host: config.host,
    port: config.port,
    secret: config.secret,
    allowedEvents: config.allowedEvents,
    defaultDiscordChannelId: config.discordChannelId,
    deliver: (channelId, message) => deliverToChannel(client, channelId, message),
  });
  return { config, route: null, server };
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
