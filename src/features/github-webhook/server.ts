import type { IncomingMessage, ServerResponse } from "node:http";

import { HttpRouter } from "../../http/router.js";
import type { HttpServerHandle } from "../../http/server.js";
import { createHttpServer } from "../../http/server.js";
import { childFor, getRootLogger } from "../../lib/logger/index.js";
import { dispatchPayload } from "./dispatcher.js";
import type { DiscordWebhookMessage } from "./formatter.js";
import { GitHubWebhookRateLimiter } from "./rate-limit.js";
import { verifySignature } from "./signature.js";

const logger = childFor(getRootLogger(), "github-webhook");

/**
 * Minimal `Readable` shape we need to drain the request body.
 *
 * `IncomingMessage` already implements it, so the seam is only used by tests.
 */
type RequestBodySource = {
  on(event: "data", listener: (chunk: Buffer) => void): void;
  on(event: "end", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
};

/**
 * Function used to actually publish a Discord message. Wired through the
 * composition root (src/index.ts) so tests can stub it without involving
 * a real Discord bot.
 */
type DeliverMessage = (channelId: string, message: DiscordWebhookMessage) => Promise<void>;

export type GitHubWebhookRouteOptions = {
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

export type GitHubWebhookServerHandle = HttpServerHandle & {
  /**
   * Read the body of an incoming HTTP request as UTF-8 text. Exposed so
   * tests can exercise the same parsing path the server uses internally.
   */
  readBody: (req: RequestBodySource) => Promise<string>;
  /**
   * Invoke the `/webhook/github` handler against an `IncomingMessage` +
   * `ServerResponse` pair without going through a TCP listener. Used by
   * the test suite to assert response codes / bodies without binding a
   * real socket.
   */
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
};

const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB — GitHub payloads are far smaller.
const WEBHOOK_PATH = "/webhook/github";

/**
 * Spin up a self-contained GitHub webhook HTTP server bound to
 * `host:port`. Internally this builds a private router, registers the
 * webhook route on it, and delegates to the shared HTTP server factory
 * (`src/http/server.ts`) — the listener is the same one `/health` and
 * `/metrics` (issue #26) will use once they migrate to `registerWebhookRoutes`.
 *
 * Tests use this entrypoint because they want a fully isolated listener
 * on an ephemeral port. Production code calls `registerWebhookRoutes` on
 * the router shared with the rest of the bot.
 */
export async function createGitHubWebhookServer(
  options: GitHubWebhookRouteOptions,
): Promise<GitHubWebhookServerHandle> {
  const router = new HttpRouter();
  const routeHandle = registerWebhookRoutes(router, options);
  const handle = await createHttpServer({
    host: options.host,
    port: options.port,
    router,
  });

  return {
    ...handle,
    readBody,
    handle: (req, res) =>
      handleRequest(req, res, {
        secret: options.secret,
        allowedEvents: options.allowedEvents,
        rateLimiter: routeHandle.rateLimiter,
        deliver: options.deliver,
        defaultDiscordChannelId: options.defaultDiscordChannelId ?? null,
        readBody,
      }),
  };
}

export type WebhookRouteHandle = {
  rateLimiter: GitHubWebhookRateLimiter;
};

/**
 * Register the GitHub webhook route on `router`. The composition root
 * (`src/index.ts`) calls this so the webhook shares the same HTTP
 * listener as `/health` and `/metrics` from issue #26.
 */
export function registerWebhookRoutes(
  router: HttpRouter,
  options: GitHubWebhookRouteOptions,
): WebhookRouteHandle {
  const rateLimiter = new GitHubWebhookRateLimiter(
    options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
  );
  const ctx: HandleContext = {
    secret: options.secret,
    allowedEvents: options.allowedEvents,
    rateLimiter,
    deliver: options.deliver,
    defaultDiscordChannelId: options.defaultDiscordChannelId ?? null,
    readBody,
  };

  router.add("POST", WEBHOOK_PATH, (req, res) => handleRequest(req, res, ctx));

  return { rateLimiter };
}

type HandleContext = {
  secret: string;
  allowedEvents: ReadonlySet<string>;
  rateLimiter: GitHubWebhookRateLimiter;
  deliver: DeliverMessage | undefined;
  defaultDiscordChannelId: string | null;
  readBody: (req: RequestBodySource) => Promise<string>;
};

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandleContext,
): Promise<void> {
  const rawUrl = req.url ?? "/";
  const path = rawUrl.split("?", 1)[0] || "/";
  const method = (req.method ?? "GET").toUpperCase();

  if (path !== WEBHOOK_PATH) {
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
    logger.warn({ reason }, "github-webhook body read error");
    sendJson(res, 400, { error: "invalid_body" });
    return;
  }

  if (!verifySignature(ctx.secret, rawBody, headerValue(req, "x-hub-signature-256"))) {
    logger.warn("github-webhook signature verification failed");
    sendJson(res, 401, { error: "invalid_signature" });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    logger.warn("github-webhook payload is not valid JSON");
    sendJson(res, 400, { error: "invalid_json" });
    return;
  }

  const headerEvent = (headerValue(req, "x-github-event") ?? "").toLowerCase();
  if (!headerEvent) {
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

  // The whitelist is keyed on labels like `release.published`, but
  // GitHub's wire header carries only the event part (`release`). The
  // dispatcher combines the header event with `payload.action` to
  // produce the final match — see `matchWhitelistEntry` in
  // `dispatcher.ts`.
  const result = dispatchPayload(headerEvent, payload, { allowedEvents: ctx.allowedEvents });

  if (result.kind === "invalid") {
    logger.warn({ reason: result.reason }, "github-webhook invalid payload");
    sendJson(res, 202, { status: "invalid", reason: result.reason });
    return;
  }

  if (result.kind === "ignored") {
    sendJson(res, 202, { status: "ignored", reason: result.reason });
    return;
  }

  const channelId = resolveChannelId(req, ctx.defaultDiscordChannelId);
  if (!channelId) {
    logger.warn("github-webhook missing Discord channel id");
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
    logger.error({ err: error }, "github-webhook Discord delivery failed");
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

function readBody(req: RequestBodySource): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    // Once `overLimit` flips, additional `data` events must NOT push into
    // `chunks` — otherwise an unauthenticated attacker can grow memory
    // unboundedly by sending a single oversized request, since signature
    // verification happens AFTER the full body is read. We still need to
    // consume the stream so the socket doesn't stall.
    let overLimit = false;

    req.on("data", (chunk: Buffer) => {
      if (overLimit) {
        return;
      }
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        overLimit = true;
        // Reject the promise but defer it until the next tick so the
        // socket's `data` listener keeps draining without re-entering us.
        queueMicrotask(() => reject(new Error("payload_too_large")));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (overLimit) {
        return; // rejection already scheduled
      }
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
