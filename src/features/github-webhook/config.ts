import { z } from "zod";

/**
 * Whitelisted GitHub event types that the bot will surface to Discord.
 *
 * The list is config-driven so deployments can opt-in to more events
 * without code changes. Anything not in this set is treated as a no-op
 * (HTTP 202 accepted, no Discord message posted).
 */
export const SUPPORTED_GITHUB_EVENTS = [
  "release.published",
  "pull_request.closed",
  "issues.opened",
] as const;

export type SupportedGitHubEvent = (typeof SUPPORTED_GITHUB_EVENTS)[number];

export function isSupportedGitHubEvent(value: string): value is SupportedGitHubEvent {
  return (SUPPORTED_GITHUB_EVENTS as readonly string[]).includes(value);
}

const configSchema = z.object({
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  GITHUB_WEBHOOK_PORT: z.coerce.number().int().min(0).max(65535).default(8081),
  GITHUB_WEBHOOK_HOST: z.string().min(1).default("127.0.0.1"),
  GITHUB_WEBHOOK_DISCORD_CHANNEL_ID: z.string().min(1).optional(),
  GITHUB_WEBHOOK_EVENTS: z.string().optional(),
});

export type GitHubWebhookConfig = {
  secret: string;
  host: string;
  port: number;
  discordChannelId: string | null;
  /** Event whitelist (lowercase GitHub event names). */
  allowedEvents: ReadonlySet<SupportedGitHubEvent>;
};

export function readGitHubWebhookConfig(env: NodeJS.ProcessEnv): GitHubWebhookConfig {
  const parsed = configSchema.parse(env);

  const allowed = (parsed.GITHUB_WEBHOOK_EVENTS ?? SUPPORTED_GITHUB_EVENTS.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is SupportedGitHubEvent =>
      isSupportedGitHubEvent(value),
    );

  // Default to the full supported list when the env value was unparseable.
  const allowedEvents = allowed.length > 0 ? new Set(allowed) : new Set(SUPPORTED_GITHUB_EVENTS);

  return {
    secret: parsed.GITHUB_WEBHOOK_SECRET,
    host: parsed.GITHUB_WEBHOOK_HOST,
    port: parsed.GITHUB_WEBHOOK_PORT,
    discordChannelId: parsed.GITHUB_WEBHOOK_DISCORD_CHANNEL_ID ?? null,
    allowedEvents,
  };
}