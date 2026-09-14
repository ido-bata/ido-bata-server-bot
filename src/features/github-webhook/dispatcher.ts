import {
  type DiscordWebhookMessage,
  extractRepoKey,
  formatIssueOpenedEvent,
  formatPullRequestEvent,
  formatReleaseEvent,
  type GitHubIssuesPayload,
  type GitHubPullRequestPayload,
  type GitHubReleasePayload,
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
  /** Allowed event labels, e.g. `release.published`. See {@link SUPPORTED_GITHUB_EVENTS}. */
  allowedEvents: ReadonlySet<string>;
};

/**
 * GitHub's `X-GitHub-Event` header carries only the resource type
 * (`release`, `pull_request`, `issues`), not the action. The action lives
 * in `payload.action`. We split the user-facing whitelist label
 * (`release.published`) so we can match both pieces against the wire.
 */
type EventAction = { event: string; action: string | null };

function splitEventLabel(label: string): EventAction | null {
  const dot = label.indexOf(".");
  if (dot < 0) {
    return null;
  }
  return { event: label.slice(0, dot), action: label.slice(dot + 1) };
}

function readAction(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const action = (payload as Record<string, unknown>).action;
  return typeof action === "string" ? action : null;
}

function isMergedPullRequest(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const pr = (payload as Record<string, unknown>).pull_request;
  if (!pr || typeof pr !== "object") {
    return false;
  }
  return (pr as Record<string, unknown>).merged === true;
}

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
 * Decide what to do with an incoming GitHub webhook.
 *
 * `headerEvent` comes from the `X-GitHub-Event` header (e.g. `release`),
 * and the action is read from `payload.action`. The whitelist entry
 * `release.published` therefore matches when the header is `release` AND
 * `payload.action === "published"`.
 */
export function dispatchPayload(
  headerEvent: string,
  payload: unknown,
  options: DispatchOptions,
): DispatchResult {
  const repoKey = extractRepoKey(payload);

  if (!repoKey) {
    return { kind: "invalid", reason: "missing repository.full_name" };
  }

  const matched = matchWhitelistEntry(headerEvent, payload, options.allowedEvents);
  if (!matched) {
    return { kind: "ignored", reason: "unknown_event", repoKey };
  }

  if (matched === "release.published") {
    if (!isReleasePayload(payload)) {
      return { kind: "invalid", reason: "release payload shape mismatch" };
    }
    const message = formatReleaseEvent(payload);
    return message
      ? { kind: "deliver", repoKey, message }
      : { kind: "ignored", reason: "unknown_event", repoKey };
  }

  if (matched === "pull_request.closed") {
    if (!isPullRequestPayload(payload)) {
      return { kind: "invalid", reason: "pull_request payload shape mismatch" };
    }
    const message = formatPullRequestEvent(payload);
    return message
      ? { kind: "deliver", repoKey, message }
      : { kind: "ignored", reason: "unknown_event", repoKey };
  }

  if (matched === "issues.opened") {
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

/**
 * Return the whitelist entry that matches `(headerEvent, payload.action,
 * payload.pull_request.merged)`, or `null` if none does. We use the
 * returned label to dispatch to the right formatter — the label keeps
 * the wire-facing naming (`release.published` etc.) while the predicate
 * uses the actual GitHub event semantics.
 */
function matchWhitelistEntry(
  headerEvent: string,
  payload: unknown,
  allowed: ReadonlySet<string>,
): string | null {
  const action = readAction(payload);
  const merged = isMergedPullRequest(payload);

  for (const entry of allowed) {
    const parts = splitEventLabel(entry);
    if (!parts) {
      continue;
    }
    if (parts.event !== headerEvent) {
      continue;
    }
    if (parts.action !== null && parts.action !== action) {
      continue;
    }
    // `pull_request.closed` is a closed-and-merged PR per the issue #36
    // acceptance criteria. A non-merged close is silently ignored so we
    // don't spam Discord for every abandoned branch.
    if (entry === "pull_request.closed" && !merged) {
      continue;
    }
    return entry;
  }

  return null;
}
