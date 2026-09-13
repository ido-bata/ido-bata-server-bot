import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { MetricsRegistry } from "./metrics.js";

export type HealthMetricsServerHandle = {
  server: Server;
  /** The actual bound port (may differ from the requested port when port=0). */
  port: number;
  close: () => Promise<void>;
};

export type CreateHealthMetricsServerOptions = {
  host: string;
  port: number;
  registry: MetricsRegistry;
};

/**
 * Spins up a minimal HTTP/1.1 server that exposes:
 *
 * - `GET /health`  → JSON liveness probe
 * - `GET /metrics` → Prometheus text format
 *
 * The server binds to `host:port`. Pass `port: 0` to bind an ephemeral
 * port (used by the test suite). The server does not read process.env
 * directly — all data shown on the wire comes from the supplied registry.
 */
export function createHealthMetricsServer(
  options: CreateHealthMetricsServerOptions,
): Promise<HealthMetricsServerHandle> {
  const { host, port, registry } = options;

  const server = createServer((req, res) => {
    handleRequest(req, res, registry).catch((error: unknown) => {
      console.error("health-metrics request failed", error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "internal_error" }));
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
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      const address = server.address();
      const actualPort = typeof address === "object" && address ? (address as AddressInfo).port : port;
      resolve({
        server,
        port: actualPort,
        close: () => closeServer(server),
      });
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  registry: MetricsRegistry,
): Promise<void> {
  const rawUrl = req.url ?? "/";
  // Strip query string — we don't use it today, but scraping clients
  // commonly pass ?collect[]= or cache-busters.
  const path = rawUrl.split("?", 1)[0] || "/";
  const method = (req.method ?? "GET").toUpperCase();

  if (method !== "GET" && method !== "HEAD") {
    sendJson(res, 405, { error: "method_not_allowed" }, { allow: "GET, HEAD" });
    return;
  }

  if (path === "/health") {
    const snap = registry.snapshot();
    const body = {
      status: "ok",
      uptime_sec: Math.max(0, Math.floor(snap.uptimeSec)),
      discord_ws: snap.discordWsConnected ? "connected" : "disconnected",
    };
    sendJson(res, 200, body, { "cache-control": "no-store" });
    return;
  }

  if (path === "/metrics") {
    const body = registry.toPrometheusText();
    res.writeHead(200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "cache-control": "no-store",
    });
    if (method === "HEAD") {
      res.end();
      return;
    }
    res.end(body);
    return;
  }

  sendJson(res, 404, { error: "not_found" });
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
