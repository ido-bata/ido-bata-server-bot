import { describe, expect, it } from "vitest";

import {
  extractRepoKey,
  formatIssueOpenedEvent,
  formatPullRequestEvent,
  formatReleaseEvent,
} from "../src/features/github-webhook/formatter.js";

describe("GitHub webhook formatter", () => {
  it("formats a release.published event into a Discord embed", () => {
    const message = formatReleaseEvent({
      action: "published",
      release: {
        tag_name: "v1.2.3",
        name: "v1.2.3 — bug fixes",
        body: "## Highlights\n- Fixed everything",
        html_url: "https://github.com/acme/widget/releases/tag/v1.2.3",
        author: {
          login: "octocat",
          html_url: "https://github.com/octocat",
          avatar_url: "https://avatars.githubusercontent.com/u/1",
        },
        published_at: "2026-09-13T12:00:00Z",
      },
      repository: {
        full_name: "acme/widget",
        html_url: "https://github.com/acme/widget",
      },
      sender: {
        login: "octocat",
        html_url: "https://github.com/octocat",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
      },
    });

    expect(message).not.toBeNull();
    const embed = message?.embeds[0];
    expect(embed?.title).toBe("Release v1.2.3 published");
    expect(embed?.url).toBe("https://github.com/acme/widget/releases/tag/v1.2.3");
    expect(embed?.color).toBe(0x2ea44f);
    expect(embed?.author?.name).toBe("@octocat");
    expect(embed?.footer?.text).toBe("acme/widget");
    expect(embed?.fields?.map((f) => f.name)).toEqual([
      "Repository",
      "Tag",
      "Release notes",
    ]);
  });

  it("returns null when the release action is not 'published'", () => {
    const result = formatReleaseEvent({
      action: "draft",
      release: {
        tag_name: "v1.2.3",
        name: null,
        body: null,
        html_url: "https://github.com/acme/widget/releases/tag/v1.2.3",
        published_at: null,
      },
      repository: {
        full_name: "acme/widget",
        html_url: "https://github.com/acme/widget",
      },
    });

    expect(result).toBeNull();
  });

  it("formats a merged pull_request.closed event", () => {
    const message = formatPullRequestEvent({
      action: "closed",
      pull_request: {
        number: 42,
        title: "Add webhook receiver",
        html_url: "https://github.com/acme/widget/pull/42",
        merged: true,
        merged_at: "2026-09-13T12:00:00Z",
        user: { login: "reviewer" },
        body: "Implements the /webhook/github endpoint.",
      },
      repository: {
        full_name: "acme/widget",
        html_url: "https://github.com/acme/widget",
      },
    });

    expect(message).not.toBeNull();
    const embed = message?.embeds[0];
    expect(embed?.title).toBe("PR #42 merged: Add webhook receiver");
    expect(embed?.url).toBe("https://github.com/acme/widget/pull/42");
    expect(embed?.color).toBe(0x6f42c8);
  });

  it("returns null when a pull_request is closed without merging", () => {
    const result = formatPullRequestEvent({
      action: "closed",
      pull_request: {
        number: 42,
        title: "Abandoned attempt",
        html_url: "https://github.com/acme/widget/pull/42",
        merged: false,
        merged_at: null,
        user: { login: "reviewer" },
      },
      repository: {
        full_name: "acme/widget",
        html_url: "https://github.com/acme/widget",
      },
    });

    expect(result).toBeNull();
  });

  it("formats an issues.opened event", () => {
    const message = formatIssueOpenedEvent({
      action: "opened",
      issue: {
        number: 7,
        title: "Bot crashes when receiving a webhook",
        html_url: "https://github.com/acme/widget/issues/7",
        body: "Steps to reproduce...",
        user: { login: "reporter" },
      },
      repository: {
        full_name: "acme/widget",
        html_url: "https://github.com/acme/widget",
      },
    });

    expect(message).not.toBeNull();
    const embed = message?.embeds[0];
    expect(embed?.title).toBe("Issue #7 opened: Bot crashes when receiving a webhook");
    expect(embed?.url).toBe("https://github.com/acme/widget/issues/7");
    expect(embed?.color).toBe(0x1f883d);
  });

  it("returns null when the issues action is not 'opened'", () => {
    const result = formatIssueOpenedEvent({
      action: "closed",
      issue: {
        number: 7,
        title: "Whatever",
        html_url: "https://github.com/acme/widget/issues/7",
        user: { login: "reporter" },
      },
      repository: {
        full_name: "acme/widget",
        html_url: "https://github.com/acme/widget",
      },
    });

    expect(result).toBeNull();
  });

  it("extracts a stable repo key from payloads", () => {
    expect(extractRepoKey({ repository: { full_name: "acme/widget" } })).toBe("acme/widget");
    expect(extractRepoKey({ repository: { other: true } })).toBeNull();
    expect(extractRepoKey(null)).toBeNull();
  });
});