import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { dispatchPayload } from "./dispatcher.js";
import type { DiscordWebhookMessage } from "./formatter.js";
import { GitHubWebhookRateLimiter } from "./rate-limit.js";
import { verifySignature } from "./signature.js";

/**
 * Minimal `Readable` shape we need to drain the request body.
 *
 * `IncomingMessage` already implements it, so the seam is only used by tests.
 */
export type RequestBodySource = {
  on(event: "data", listener: (chunk: Buffer) => void): void;
  on(event: "end", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
};

/**
 * Function used to actually publish a Discord message. Wired through the
 * composition root (src/index.ts) so tests can stub it without involving
 * a real Discord bot.
 */
export type DeliverMessage = (channelId: string, message: DiscordWebhookMessage) => Promise<void>;

export type GitHubWebhookServerOptions = {
  host: string;
  port: number;
  secret: string;
  allowedEvents: ReadonlySet<string>;
  deliver?: DeliverMessage;
  /**
   * Optional Discord channel override — when omitted, the server falls back
   * to the per-request channel id embedded in the URL query string
   * (`?channel=<id>`). The composition root supplies the production
   * default.
   */
  defaultDiscordChannelId?: string | null;
  /** Window in milliseconds between accepted deliveries per repo (default 60_000). */
  rateLimitWindowMs?: number;
};

export type GitHubWebhookServerHandle = {
  server: Server;
  /** The actual bound port (may differ from the requested port when port=0). */
  port: number;
  close: () => Promise<void>;
  /**
   * Read the body of an incoming HTTP request as UTF-8 text. Exposed so
   * tests can exercise the same parsing path the server uses internally.
   */
  readBody: (req: RequestBodySource) => Promise<string>;
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
};

const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB — GitHub payloads are far smaller.

export function createGitHubWebhookServer(
  options: GitHubWebhookServerOptions,
): Promise<GitHubWebhookServerHandle> {
  const {
    host,
    port: requestedPort,
    secret,
    allowedEvents,
    deliver,
    defaultDiscordChannelId = null,
    rateLimitWindowMs = DEFAULT_RATE_LIMIT_WINDOW_MS,
  } = options;

  const rateLimiter = new GitHubWebhookRateLimiter(rateLimitWindowMs);

  const server = createServer((req, res) => {
    handleRequest(req, res, {
      secret,
      allowedEvents,
      rateLimiter,
      deliver,
      defaultDiscordChannelId,
      readBody,
    }).catch((error: unknown) => {
      console.error("github-webhook request failed", error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal_error" });
      } else {
        res.destroy();
      }
    });
  });

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(requestedPort, host, () => {
      server.removeListener("error", onError);
      const address = server.address();
      const actualPort = typeof address === "object" && address ? (address as AddressInfo).port : requestedPort;
      resolve({
        server,
        port: actualPort,
        close: () => closeServer(server),
        readBody,
        handle: (req, res) =>
          handleRequest(req, res, {
            secret,
            allowedEvents,
            rateLimiter,
            deliver,
            defaultDiscordChannelId,
            readBody,
          }),
      });
    });
  });
}

type HandleContext = {
  secret: string;
  allowedEvents: ReadonlySet<string>;
  rateLimiter: GitHubWebhookRateLimiter;
  deliver: DeliverMessage | undefined;
  defaultDiscordChannelId: string | null;
  readBody: (req: RequestBodySource) => Promise<string>;
};

export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandleContext,
): Promise<void> {
  const rawUrl = req.url ?? "/";
  const path = rawUrl.split("?", 1)[0] || "/";
  const method = (req.method ?? "GET").toUpperCase();

  if (path !== "/webhook/github") {
    sendJson(res, 404, { error: "not_found" });
    return;
  }

  if (method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" }, { allow: "POST" });
    return;
  }

  let rawBody: string;
  try {
    rawBody = await ctx.readBody(req);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid body";
    console.warn(`github-webhook body read error: ${reason}`);
    sendJson(res, 400, { error: "invalid_body" });
    return;
  }

  if (!verifySignature(ctx.secret, rawBody, headerValue(req, "x-hub-signature-256"))) {
    console.warn("github-webhook signature verification failed");
    sendJson(res, 401, { error: "invalid_signature" });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.warn("github-webhook payload is not valid JSON");
    sendJson(res, 400, { error: "invalid_json" });
    return;
  }

  const eventName = (headerValue(req, "x-github-event") ?? "").toLowerCase();
  if (!eventName) {
    sendJson(res, 400, { error: "missing_github_event_header" });
    return;
  }

  const repoKey = repoKeyFromPayload(payload);
  if (repoKey) {
    const decision = ctx.rateLimiter.check(repoKey);
    if (!decision.allowed) {
      const retryAfter = Math.ceil(decision.retryAfterMs / 1000);
      sendJson(
        res,
        429,
        { error: "rate_limited", repo: repoKey, retry_after_seconds: retryAfter },
        { "retry-after": String(retryAfter) },
      );
      return;
    }
  }

  const result = dispatchPayload(eventName, payload, { allowedEvents: ctx.allowedEvents });

  if (result.kind === "invalid") {
    console.warn(`github-webhook invalid payload: ${result.reason}`);
    sendJson(res, 202, { status: "invalid", reason: result.reason });
    return;
  }

  if (result.kind === "ignored") {
    sendJson(res, 202, { status: "ignored", reason: result.reason });
    return;
  }

  const channelId = resolveChannelId(req, ctx.defaultDiscordChannelId);
  if (!channelId) {
    console.warn("github-webhook missing Discord channel id");
    sendJson(res, 503, { error: "discord_channel_unconfigured" });
    return;
  }

  if (!ctx.deliver) {
    // In tests we may run without a delivery callback; treat that as a
    // successful local ACK so the sender doesn't keep retrying.
    sendJson(res, 202, { status: "no_delivery_handler" });
    return;
  }

  try {
    await ctx.deliver(channelId, result.message);
    sendJson(res, 200, { status: "delivered", repo: result.repoKey });
  } catch (error) {
    console.error("github-webhook Discord delivery failed", error);
    sendJson(res, 502, { error: "discord_delivery_failed" });
  }
}

function repoKeyFromPayload(payload: unknown): string | null {
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

function resolveChannelId(req: IncomingMessage, fallback: string | null): string | null {
  const rawUrl = req.url ?? "";
  const queryStart = rawUrl.indexOf("?");
  if (queryStart !== -1) {
    const params = new URLSearchParams(rawUrl.slice(queryStart + 1));
    const channel = params.get("channel");
    if (channel) {
      return channel;
    }
  }
  return fallback;
}

function headerValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.length > 0) {
    return value[0];
  }
  return null;
}

export function readBody(req: RequestBodySource): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("payload_too_large"));
        req.on("data", () => {
          // keep draining so the socket doesn't stall.
        });
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", (err: Error) => {
      reject(err);
    });
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}