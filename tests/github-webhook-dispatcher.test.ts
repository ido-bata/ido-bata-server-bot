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

describe("GitHub webhook dispatcher", () => {
  it("returns 'deliver' for a whitelisted release event", () => {
    const result = dispatchPayload("release.published", releasePayload, { allowedEvents: allowed });
    expect(result.kind).toBe("deliver");
    if (result.kind === "deliver") {
      expect(result.repoKey).toBe("acme/widget");
      expect(result.message.embeds[0].title).toBe("Release v0.2.0 published");
    }
  });

  it("returns 'deliver' for a merged pull_request.closed event", () => {
    const result = dispatchPayload("pull_request.closed", prPayload, { allowedEvents: allowed });
    expect(result.kind).toBe("deliver");
  });

  it("returns 'ignored' for a non-merged pull request", () => {
    const payload = {
      ...prPayload,
      pull_request: { ...prPayload.pull_request, merged: false, merged_at: null },
    };
    const result = dispatchPayload("pull_request.closed", payload, { allowedEvents: allowed });
    expect(result.kind).toBe("ignored");
  });

  it("returns 'ignored' for unknown events even when payload is valid", () => {
    const result = dispatchPayload("star.created", releasePayload, { allowedEvents: allowed });
    expect(result.kind).toBe("ignored");
  });

  it("returns 'invalid' when the payload has no repository.full_name", () => {
    const result = dispatchPayload("release.published", { action: "published" }, {
      allowedEvents: allowed,
    });
    expect(result.kind).toBe("invalid");
  });

  it("returns 'invalid' when a release payload is structurally broken", () => {
    const result = dispatchPayload(
      "release.published",
      { action: "published", repository: { full_name: "acme/widget" } },
      { allowedEvents: allowed },
    );
    expect(result.kind).toBe("invalid");
  });
});