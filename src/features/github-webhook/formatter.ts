/**
 * Convert a subset of GitHub webhook payloads into Discord embed payloads.
 *
 * We only render events that the bot actually cares about:
 *
 * - `release.published`
 * - `pull_request.closed` (only when merged)
 * - `issues.opened`
 *
 * Anything else returns `null` so the caller can short-circuit and not
 * forward the message to Discord.
 */

export type DiscordEmbedField = {
  name: string;
  value: string;
  inline?: boolean;
};

export type DiscordEmbed = {
  title: string;
  url?: string;
  description?: string;
  color?: number;
  timestamp?: string;
  fields?: DiscordEmbedField[];
  footer?: { text: string };
  author?: { name: string; url?: string; icon_url?: string };
};

export type DiscordWebhookMessage = {
  embeds: DiscordEmbed[];
};

/**
 * Minimal shape we extract from a GitHub webhook payload. We accept
 * `unknown` from the wire and validate field-by-field, so a payload
 * that doesn't look like what we expect is rejected as unknown rather
 * than crashing the formatter.
 */
export type GitHubReleasePayload = {
  action: string;
  release: {
    tag_name: string;
    name: string | null;
    body: string | null;
    html_url: string;
    author?: { login: string; html_url?: string; avatar_url?: string };
    published_at: string | null;
  };
  repository: {
    full_name: string;
    html_url: string;
  };
  sender?: { login: string; html_url?: string; avatar_url?: string };
};

export type GitHubPullRequestPayload = {
  action: string;
  pull_request: {
    number: number;
    title: string;
    html_url: string;
    merged: boolean;
    merged_at: string | null;
    user: { login: string; html_url?: string; avatar_url?: string };
    body?: string | null;
  };
  repository: {
    full_name: string;
    html_url: string;
  };
};

export type GitHubIssuesPayload = {
  action: string;
  issue: {
    number: number;
    title: string;
    html_url: string;
    body?: string | null;
    user: { login: string; html_url?: string; avatar_url?: string };
  };
  repository: {
    full_name: string;
    html_url: string;
  };
};

const COLOR_RELEASE = 0x2ea44f; // green
const COLOR_PR_MERGED = 0x6f42c8; // purple
const COLOR_ISSUE_OPENED = 0x1f883d; // green-ish

function truncate(value: string, max = 1024): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 3)}...`;
}

function shortBody(body: string | null | undefined): string {
  if (!body) {
    return "_No description provided._";
  }
  const stripped = body.replace(/\r\n/g, "\n").trim();
  return truncate(stripped || "_No description provided._", 600);
}

function buildRepoFooter(repository: { full_name: string }): { text: string } {
  return { text: repository.full_name };
}

function buildSenderAuthor(sender: {
  login: string;
  html_url?: string;
  avatar_url?: string;
}): { name: string; url?: string; icon_url?: string } {
  return {
    name: `@${sender.login}`,
    url: sender.html_url,
    icon_url: sender.avatar_url,
  };
}

export function formatReleaseEvent(payload: GitHubReleasePayload): DiscordWebhookMessage | null {
  if (payload.action !== "published") {
    return null;
  }

  const { release, repository, sender } = payload;
  const embed: DiscordEmbed = {
    title: `Release ${release.tag_name} published`,
    url: release.html_url,
    description: truncate(release.name ?? release.tag_name, 240),
    color: COLOR_RELEASE,
    timestamp: release.published_at ?? undefined,
    fields: [
      { name: "Repository", value: repository.full_name, inline: true },
      { name: "Tag", value: release.tag_name, inline: true },
      { name: "Release notes", value: shortBody(release.body), inline: false },
    ],
    footer: buildRepoFooter(repository),
  };

  if (sender) {
    embed.author = buildSenderAuthor(sender);
  }

  return { embeds: [embed] };
}

export function formatPullRequestEvent(
  payload: GitHubPullRequestPayload,
): DiscordWebhookMessage | null {
  if (payload.action !== "closed" || !payload.pull_request.merged) {
    return null;
  }

  const { pull_request: pr, repository } = payload;
  const embed: DiscordEmbed = {
    title: `PR #${pr.number} merged: ${truncate(pr.title, 200)}`,
    url: pr.html_url,
    description: shortBody(pr.body),
    color: COLOR_PR_MERGED,
    timestamp: pr.merged_at ?? undefined,
    fields: [
      { name: "Repository", value: repository.full_name, inline: true },
      { name: "Author", value: `@${pr.user.login}`, inline: true },
    ],
    footer: buildRepoFooter(repository),
  };

  return { embeds: [embed] };
}

export function formatIssueOpenedEvent(payload: GitHubIssuesPayload): DiscordWebhookMessage | null {
  if (payload.action !== "opened") {
    return null;
  }

  const { issue, repository } = payload;
  const embed: DiscordEmbed = {
    title: `Issue #${issue.number} opened: ${truncate(issue.title, 200)}`,
    url: issue.html_url,
    description: shortBody(issue.body),
    color: COLOR_ISSUE_OPENED,
    fields: [
      { name: "Repository", value: repository.full_name, inline: true },
      { name: "Author", value: `@${issue.user.login}`, inline: true },
    ],
    footer: buildRepoFooter(repository),
  };

  return { embeds: [embed] };
}

/**
 * Extract a stable `owner/repo` key from any payload that carries a
 * `repository.full_name` field. Returns `null` for payloads that don't
 * match any supported shape — used as the rate-limit bucket key.
 */
export function extractRepoKey(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const obj = payload as Record<string, unknown>;
  const repo = obj.repository;
  if (!repo || typeof repo !== "object") {
    return null;
  }
  const fullName = (repo as Record<string, unknown>).full_name;
  return typeof fullName === "string" ? fullName : null;
}