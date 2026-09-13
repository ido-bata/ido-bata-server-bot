import { EventEmitter } from "node:events";

import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

import {
  createGitHubWebhookServer,
  type GitHubWebhookServerHandle,
} from "../src/features/github-webhook/server.js";
import { computeSignature } from "../src/features/github-webhook/signature.js";

type DeliverCall = { channelId: string; embeds: unknown[] };

async function startServer(): Promise<{
  handle: GitHubWebhookServerHandle;
  deliverCalls: DeliverCall[];
  stop: () => Promise<void>;
}> {
  const deliverCalls: DeliverCall[] = [];
  const handle = await createGitHubWebhookServer({
    host: "127.0.0.1",
    port: 0,
    secret: "test-secret",
    allowedEvents: new Set(["release.published", "pull_request.closed", "issues.opened"]),
    defaultDiscordChannelId: "channel-dev",
    deliver: async (channelId, message) => {
      deliverCalls.push({ channelId, embeds: message.embeds });
    },
    rateLimitWindowMs: 60_000,
  });

  return {
    handle,
    deliverCalls,
    stop: () => handle.close(),
  };
}

function makeRequest(headers: Record<string, string>, body: string): IncomingMessage {
  const emitter = new EventEmitter();
  (emitter as unknown as IncomingMessage).headers = headers;
  (emitter as unknown as IncomingMessage).method = "POST";
  (emitter as unknown as IncomingMessage).url = "/webhook/github";
  queueMicrotask(() => {
    emitter.emit("data", Buffer.from(body, "utf8"));
    emitter.emit("end");
  });
  return emitter as unknown as IncomingMessage;
}

function captureResponse(): {
  res: ServerResponse;
  status: () => number;
  body: () => string;
  headers: () => Record<string, string>;
} {
  const headersOut: Record<string, string> = {};
  let statusCode = 0;
  const chunks: Buffer[] = [];

  const res = {
    headersSent: true,
    writeHead(status: number, headers: Record<string, string>) {
      statusCode = status;
      Object.assign(headersOut, headers);
    },
    end(payload?: string | Buffer) {
      if (payload !== undefined) {
        chunks.push(Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
      }
    },
    destroy() {
      // noop
    },
  } as unknown as ServerResponse;

  return {
    res,
    status: () => statusCode,
    body: () => Buffer.concat(chunks).toString("utf8"),
    headers: () => headersOut,
  };
}

const releasePayload = {
  action: "published",
  release: {
    tag_name: "v0.2.0",
    name: "Release 0.2.0",
    body: "All the new things",
    html_url: "https://github.com/acme/widget/releases/tag/v0.2.0",
    published_at: "2026-09-13T00:00:00Z",
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
    title: "Add webhook receiver",
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
    title: "Webhook receiver missing",
    html_url: "https://github.com/acme/widget/issues/7",
    user: { login: "reporter" },
  },
  repository: {
    full_name: "acme/widget",
    html_url: "https://github.com/acme/widget",
  },
};

describe("GitHub webhook HTTP server", () => {
  it("delivers a signed release.published event to Discord", async () => {
    const { handle, deliverCalls, stop } = await startServer();
    try {
      const rawBody = JSON.stringify(releasePayload);
      const signature = computeSignature("test-secret", rawBody);

      const req = makeRequest(
        {
          "x-github-event": "release.published",
          "x-hub-signature-256": signature,
          "content-type": "application/json",
        },
        rawBody,
      );
      const captured = captureResponse();

      await handle.handle(req, captured.res);

      expect(captured.status()).toBe(200);
      expect(deliverCalls).toHaveLength(1);
      expect(deliverCalls[0].channelId).toBe("channel-dev");
      expect(deliverCalls[0].embeds).toHaveLength(1);
      expect((deliverCalls[0].embeds[0] as { title: string }).title).toBe(
        "Release v0.2.0 published",
      );
    } finally {
      await stop();
    }
  });

  it("rejects requests missing the signature header", async () => {
    const { handle, deliverCalls, stop } = await startServer();
    try {
      const rawBody = JSON.stringify(releasePayload);
      const req = makeRequest(
        {
          "x-github-event": "release.published",
          "content-type": "application/json",
        },
        rawBody,
      );
      const captured = captureResponse();

      await handle.handle(req, captured.res);

      expect(captured.status()).toBe(401);
      expect(deliverCalls).toHaveLength(0);
    } finally {
      await stop();
    }
  });

  it("rejects requests with an invalid signature", async () => {
    const { handle, deliverCalls, stop } = await startServer();
    try {
      const rawBody = JSON.stringify(releasePayload);
      const req = makeRequest(
        {
          "x-github-event": "release.published",
          "x-hub-signature-256": computeSignature("wrong-secret", rawBody),
          "content-type": "application/json",
        },
        rawBody,
      );
      const captured = captureResponse();

      await handle.handle(req, captured.res);

      expect(captured.status()).toBe(401);
      expect(deliverCalls).toHaveLength(0);
    } finally {
      await stop();
    }
  });

  it("ACKs (202) for unknown events without delivering", async () => {
    const { handle, deliverCalls, stop } = await startServer();
    try {
      const rawBody = JSON.stringify(releasePayload);
      const req = makeRequest(
        {
          "x-github-event": "star.created",
          "x-hub-signature-256": computeSignature("test-secret", rawBody),
          "content-type": "application/json",
        },
        rawBody,
      );
      const captured = captureResponse();

      await handle.handle(req, captured.res);

      expect(captured.status()).toBe(202);
      expect(deliverCalls).toHaveLength(0);
    } finally {
      await stop();
    }
  });

  it("throttles a second delivery from the same repo within the window", async () => {
    const { handle, deliverCalls, stop } = await startServer();
    try {
      const rawBody = JSON.stringify(prPayload);

      const headers = {
        "x-github-event": "pull_request.closed",
        "x-hub-signature-256": computeSignature("test-secret", rawBody),
        "content-type": "application/json",
      };

      const first = captureResponse();
      await handle.handle(makeRequest(headers, rawBody), first.res);
      expect(first.status()).toBe(200);
      expect(deliverCalls).toHaveLength(1);

      const second = captureResponse();
      await handle.handle(makeRequest(headers, rawBody), second.res);
      expect(second.status()).toBe(429);
      expect(second.headers()["retry-after"]).toBeDefined();
      expect(deliverCalls).toHaveLength(1);
    } finally {
      await stop();
    }
  });

  it("delivers an issue.opened event", async () => {
    const { handle, deliverCalls, stop } = await startServer();
    try {
      const rawBody = JSON.stringify(issuePayload);
      const req = makeRequest(
        {
          "x-github-event": "issues.opened",
          "x-hub-signature-256": computeSignature("test-secret", rawBody),
          "content-type": "application/json",
        },
        rawBody,
      );
      const captured = captureResponse();

      await handle.handle(req, captured.res);

      expect(captured.status()).toBe(200);
      expect(deliverCalls).toHaveLength(1);
      expect((deliverCalls[0].embeds[0] as { title: string }).title.startsWith("Issue #7")).toBe(true);
    } finally {
      await stop();
    }
  });

  it("returns 404 for unknown paths", async () => {
    const { handle, stop } = await startServer();
    try {
      const req = makeRequest({}, "");
      (req as unknown as { url: string }).url = "/health";
      const captured = captureResponse();

      await handle.handle(req, captured.res);

      expect(captured.status()).toBe(404);
    } finally {
      await stop();
    }
  });

  it("returns 405 for non-POST methods", async () => {
    const { handle, stop } = await startServer();
    try {
      const req = makeRequest({}, "");
      (req as unknown as { method: string }).method = "GET";
      const captured = captureResponse();

      await handle.handle(req, captured.res);

      expect(captured.status()).toBe(405);
      expect(captured.headers().allow).toBe("POST");
    } finally {
      await stop();
    }
  });

  it("falls back to the default channel when no channel query is supplied", async () => {
    const deliverFn = vi.fn(async () => undefined);
    const handle = await createGitHubWebhookServer({
      host: "127.0.0.1",
      port: 0,
      secret: "test-secret",
      allowedEvents: new Set(["issues.opened"]),
      defaultDiscordChannelId: "default-channel",
      deliver: deliverFn,
    });

    try {
      const rawBody = JSON.stringify(issuePayload);
      const req = makeRequest(
        {
          "x-github-event": "issues.opened",
          "x-hub-signature-256": computeSignature("test-secret", rawBody),
        },
        rawBody,
      );
      const captured = captureResponse();

      await handle.handle(req, captured.res);

      expect(captured.status()).toBe(200);
      expect(deliverFn).toHaveBeenCalledWith("default-channel", expect.anything());
    } finally {
      await handle.close();
    }
  });

  it("uses a ?channel= override when supplied", async () => {
    const deliverFn = vi.fn(async () => undefined);
    const handle = await createGitHubWebhookServer({
      host: "127.0.0.1",
      port: 0,
      secret: "test-secret",
      allowedEvents: new Set(["issues.opened"]),
      defaultDiscordChannelId: "default-channel",
      deliver: deliverFn,
    });

    try {
      const rawBody = JSON.stringify(issuePayload);
      const req = makeRequest(
        {
          "x-github-event": "issues.opened",
          "x-hub-signature-256": computeSignature("test-secret", rawBody),
        },
        rawBody,
      );
      (req as unknown as { url: string }).url = "/webhook/github?channel=override-channel";
      const captured = captureResponse();

      await handle.handle(req, captured.res);

      expect(captured.status()).toBe(200);
      expect(deliverFn).toHaveBeenCalledWith("override-channel", expect.anything());
    } finally {
      await handle.close();
    }
  });
});