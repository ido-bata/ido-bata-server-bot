import { describe, expect, it } from "vitest";

import { dispatchPayload } from "../src/features/github-webhook/dispatcher.js";

const allowed = new Set(["release.published", "pull_request.closed", "issues.opened"]);

const releasePayload = {
  action: "published",
  release: {
    tag_name: "v0.2.0",
    name: null,
    body: null,
    html_url: "https://github.com/acme/widget/releases/tag/v0.2.0",
    published_at: null,
  },
  repository: {
    full_name: "acme/widget",
    html_url: "https://github.com/acme/widget",
  },
};

const prPayload = {
  action: "closed",
  pull_request: {
    number: 42,
    title: "Webhook",
    html_url: "https://github.com/acme/widget/pull/42",
    merged: true,
    merged_at: "2026-09-13T00:00:00Z",
    user: { login: "reviewer" },
  },
  repository: {
    full_name: "acme/widget",
    html_url: "https://github.com/acme/widget",
  },
};

const issuePayload = {
  action: "opened",
  issue: {
    number: 7,
    title: "Webhook missing",
    html_url: "https://github.com/acme/widget/issues/7",
    user: { login: "reporter" },
  },
  repository: {
    full_name: "acme/widget",
    html_url: "https://github.com/acme/widget",
  },
};

describe("GitHub webhook dispatcher", () => {
  it("matches (header=release, action=published) against the release.published whitelist entry", () => {
    const result = dispatchPayload("release", releasePayload, { allowedEvents: allowed });
    expect(result.kind).toBe("deliver");
    if (result.kind === "deliver") {
      expect(result.repoKey).toBe("acme/widget");
      expect(result.message.embeds[0].title).toBe("Release v0.2.0 published");
    }
  });

  it("matches (header=pull_request, action=closed) with merged=true against pull_request.closed", () => {
    const result = dispatchPayload("pull_request", prPayload, { allowedEvents: allowed });
    expect(result.kind).toBe("deliver");
  });

  it("ignores a pull_request.closed that wasn't merged (issue #36 acceptance)", () => {
    const payload = {
      ...prPayload,
      pull_request: { ...prPayload.pull_request, merged: false, merged_at: null },
    };
    const result = dispatchPayload("pull_request", payload, { allowedEvents: allowed });
    expect(result.kind).toBe("ignored");
  });

  it("matches (header=issues, action=opened) against the issues.opened whitelist entry", () => {
    const result = dispatchPayload("issues", issuePayload, { allowedEvents: allowed });
    expect(result.kind).toBe("deliver");
  });

  it("ignores a release header with an action that isn't whitelisted (e.g. unpublished)", () => {
    const payload = { ...releasePayload, action: "unpublished" };
    const result = dispatchPayload("release", payload, { allowedEvents: allowed });
    expect(result.kind).toBe("ignored");
  });

  it("ignores unknown event headers even when the payload is valid", () => {
    const result = dispatchPayload("star.created", releasePayload, { allowedEvents: allowed });
    expect(result.kind).toBe("ignored");
  });

  it("returns 'invalid' when the payload has no repository.full_name", () => {
    const result = dispatchPayload("release", { action: "published" }, {
      allowedEvents: allowed,
    });
    expect(result.kind).toBe("invalid");
  });

  it("returns 'invalid' when a release payload is structurally broken", () => {
    const result = dispatchPayload(
      "release",
      { action: "published", repository: { full_name: "acme/widget" } },
      { allowedEvents: allowed },
    );
    expect(result.kind).toBe("invalid");
  });
});