import {
  type DiscordWebhookMessage,
  extractRepoKey,
  formatIssueOpenedEvent,
  formatPullRequestEvent,
  type GitHubIssuesPayload,
  type GitHubPullRequestPayload,
  type GitHubReleasePayload,
  formatReleaseEvent,
} from "./formatter.js";

/**
 * Result of attempting to convert a payload into a Discord message.
 *
 * - `deliver` — payload matched a supported event; the embed is ready.
 * - `ignored` — payload was a valid GitHub webhook but the event/action
 *   isn't in the whitelist. The caller should still ACK with 2xx (the
 *   sender doesn't need to retry) but no Discord message is sent.
 * - `invalid` — payload is structurally broken (missing repository etc.).
 *   The caller should log and ACK with 2xx.
 */
export type DispatchResult =
  | { kind: "deliver"; repoKey: string; message: DiscordWebhookMessage }
  | { kind: "ignored"; reason: "unknown_event" | "no_repo_key"; repoKey: string | null }
  | { kind: "invalid"; reason: string };

export type DispatchOptions = {
  /** Allowed event types (lowercase GitHub event name). */
  allowedEvents: ReadonlySet<string>;
};

function isReleasePayload(value: unknown): value is GitHubReleasePayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const obj = value as Record<string, unknown>;
  const release = obj.release;
  if (!release || typeof release !== "object") {
    return false;
  }
  const releaseObj = release as Record<string, unknown>;
  return (
    typeof releaseObj.tag_name === "string" &&
    typeof releaseObj.html_url === "string" &&
    typeof obj.action === "string"
  );
}

function isPullRequestPayload(value: unknown): value is GitHubPullRequestPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const obj = value as Record<string, unknown>;
  const pr = obj.pull_request;
  if (!pr || typeof pr !== "object") {
    return false;
  }
  const prObj = pr as Record<string, unknown>;
  return (
    typeof prObj.number === "number" &&
    typeof prObj.title === "string" &&
    typeof prObj.html_url === "string" &&
    typeof prObj.merged === "boolean" &&
    typeof obj.action === "string"
  );
}

function isIssuesPayload(value: unknown): value is GitHubIssuesPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const obj = value as Record<string, unknown>;
  const issue = obj.issue;
  if (!issue || typeof issue !== "object") {
    return false;
  }
  const issueObj = issue as Record<string, unknown>;
  return (
    typeof issueObj.number === "number" &&
    typeof issueObj.title === "string" &&
    typeof issueObj.html_url === "string" &&
    typeof obj.action === "string"
  );
}

/**
 * Decide what to do with an incoming GitHub webhook payload.
 */
export function dispatchPayload(eventName: string, payload: unknown, options: DispatchOptions): DispatchResult {
  const repoKey = extractRepoKey(payload);

  if (!repoKey) {
    return { kind: "invalid", reason: "missing repository.full_name" };
  }

  if (!options.allowedEvents.has(eventName)) {
    return { kind: "ignored", reason: "unknown_event", repoKey };
  }

  if (eventName === "release.published") {
    if (!isReleasePayload(payload)) {
      return { kind: "invalid", reason: "release payload shape mismatch" };
    }
    const message = formatReleaseEvent(payload);
    return message
      ? { kind: "deliver", repoKey, message }
      : { kind: "ignored", reason: "unknown_event", repoKey };
  }

  if (eventName === "pull_request.closed" || eventName === "pull_request.merged") {
    if (!isPullRequestPayload(payload)) {
      return { kind: "invalid", reason: "pull_request payload shape mismatch" };
    }
    const message = formatPullRequestEvent(payload);
    return message
      ? { kind: "deliver", repoKey, message }
      : { kind: "ignored", reason: "unknown_event", repoKey };
  }

  if (eventName === "issues.opened") {
    if (!isIssuesPayload(payload)) {
      return { kind: "invalid", reason: "issues payload shape mismatch" };
    }
    const message = formatIssueOpenedEvent(payload);
    return message
      ? { kind: "deliver", repoKey, message }
      : { kind: "ignored", reason: "unknown_event", repoKey };
  }

  return { kind: "ignored", reason: "unknown_event", repoKey };
}