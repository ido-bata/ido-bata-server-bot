import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createHealthMetricsServer,
  type HealthMetricsServerHandle,
} from "../src/features/health-metrics/server.js";
import { MetricsRegistry } from "../src/features/health-metrics/metrics.js";

const HOST = "127.0.0.1";
const EPHEMERAL_PORT = 0;
const FAKE_TOKEN = "MTIzNDU2Nzg5MC5hYmNkZWYuMTIzNDU2Nzg5MA.GhIjKl.MnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrStUvWx";

type TestHandle = {
  server: HealthMetricsServerHandle;
  registry: MetricsRegistry;
};

async function startServer(getUptimeSec?: () => number): Promise<TestHandle> {
  const registry = new MetricsRegistry(getUptimeSec ? { getUptimeSec } : undefined);
  const server = await createHealthMetricsServer({
    host: HOST,
    port: EPHEMERAL_PORT,
    registry,
  });
  return { server, registry };
}

describe("health-metrics HTTP server", () => {
  let handle: TestHandle | null = null;

  afterEach(async () => {
    if (handle) {
      await handle.server.close();
      handle = null;
    }
    delete process.env.DISCORD_TOKEN;
  });

  it("binds to an ephemeral port when port=0", async () => {
    handle = await startServer();
    expect(handle.server.port).toBeGreaterThan(0);
    expect(handle.server.port).toBeLessThan(65536);
  });

  describe("GET /health", () => {
    it("returns 200 with status:ok, uptime_sec, and discord_ws", async () => {
      handle = await startServer(() => 13);
      handle.registry.setDiscordWsConnected(true);

      const res = await fetch(`http://${HOST}:${handle.server.port}/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("cache-control")).toBe("no-store");

      const body = (await res.json()) as {
        status: string;
        uptime_sec: number;
        discord_ws: string;
      };
      expect(body).toEqual({
        status: "ok",
        uptime_sec: 13,
        discord_ws: "connected",
      });
    });

    it("reports discord_ws:disconnected when the registry says so", async () => {
      handle = await startServer(() => 0);
      handle.registry.setDiscordWsConnected(false);

      const body = await getJson(`/health`);
      expect(body).toMatchObject({
        status: "ok",
        uptime_sec: 0,
        discord_ws: "disconnected",
      });
    });

    it("clamps negative uptime to zero", async () => {
      handle = await startServer(() => -5);
      handle.registry.setDiscordWsConnected(true);

      const body = await getJson(`/health`);
      expect(body).toMatchObject({ uptime_sec: 0 });
    });

    async function getJson(path: string): Promise<Record<string, unknown>> {
      const res = await fetch(`http://${HOST}:${handle!.server.port}${path}`);
      return (await res.json()) as Record<string, unknown>;
    }
  });

  describe("GET /metrics", () => {
    it("returns 200 with Prometheus text content type and the four required metric families", async () => {
      handle = await startServer(() => 100);
      handle.registry.setDiscordWsConnected(true);
      handle.registry.setTimekeeperActiveSessions(1);
      handle.registry.recordCommandInvocation("ping", "ok");
      handle.registry.recordCommandInvocation("ping", "error");

      const res = await fetch(`http://${HOST}:${handle.server.port}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^text\/plain; version=0\.0\.4/);

      const body = await res.text();
      expect(body).toMatch(/# HELP bot_uptime_seconds /);
      expect(body).toMatch(/# TYPE bot_uptime_seconds gauge/);
      expect(body).toMatch(/^bot_uptime_seconds 100$/m);

      expect(body).toMatch(/# HELP bot_discord_ws_connected /);
      expect(body).toMatch(/^bot_discord_ws_connected 1$/m);

      expect(body).toMatch(/# HELP bot_timekeeper_active_sessions /);
      expect(body).toMatch(/^bot_timekeeper_active_sessions 1$/m);

      expect(body).toMatch(/# HELP bot_command_invocations_total /);
      expect(body).toMatch(/# TYPE bot_command_invocations_total counter/);
      expect(body).toMatch(/^bot_command_invocations_total\{command="ping",status="ok"\} 1$/m);
      expect(body).toMatch(/^bot_command_invocations_total\{command="ping",status="error"\} 1$/m);
    });

    it("emits discord_ws_connected as 0 when disconnected", async () => {
      handle = await startServer(() => 0);

      const body = await fetch(`http://${HOST}:${handle.server.port}/metrics`).then((r) =>
        r.text(),
      );
      expect(body).toMatch(/^bot_discord_ws_connected 0$/m);
    });

    it("never leaks the Discord token into /metrics output (regression guard)", async () => {
      process.env.DISCORD_TOKEN = FAKE_TOKEN;
      handle = await startServer(() => 0);
      handle.registry.recordCommandInvocation("safe-command", "ok");

      const body = await fetch(`http://${HOST}:${handle.server.port}/metrics`).then((r) =>
        r.text(),
      );
      expect(body).not.toContain(FAKE_TOKEN);
      // Also avoid leaking the env var name itself.
      expect(body).not.toContain("DISCORD_TOKEN");
      // Generic pattern that catches base64-ish token fragments too.
      expect(body).not.toMatch(/[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/);
    });

    it("never leaks the Discord token into /health output (regression guard)", async () => {
      process.env.DISCORD_TOKEN = FAKE_TOKEN;
      handle = await startServer(() => 0);

      const body = await fetch(`http://${HOST}:${handle.server.port}/health`).then((r) =>
        r.json(),
      );
      const rendered = JSON.stringify(body);
      expect(rendered).not.toContain(FAKE_TOKEN);
      expect(rendered).not.toContain("DISCORD_TOKEN");
    });
  });

  describe("error paths", () => {
    it("returns 404 with JSON error for unknown paths", async () => {
      handle = await startServer();

      const res = await fetch(`http://${HOST}:${handle.server.port}/unknown`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body).toEqual({ error: "not_found" });
    });

    it("returns 405 with Allow header for non-GET/HEAD methods on /health", async () => {
      handle = await startServer();

      const res = await fetch(`http://${HOST}:${handle.server.port}/health`, { method: "POST" });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
    });

    it("returns 405 for non-GET/HEAD methods on /metrics", async () => {
      handle = await startServer();

      const res = await fetch(`http://${HOST}:${handle.server.port}/metrics`, { method: "PUT" });
      expect(res.status).toBe(405);
    });

    it("rejects bind to a port that is already in use", async () => {
      // Bind a first server on an ephemeral port, then try to bind a
      // second one on the same port — the second one must reject.
      handle = await startServer();
      const takenPort = handle.server.port;

      await expect(
        createHealthMetricsServer({
          host: HOST,
          port: takenPort,
          registry: new MetricsRegistry(),
        }),
      ).rejects.toThrow();
    });
  });

  describe("HEAD requests", () => {
    it("returns 200 with empty body on HEAD /health", async () => {
      handle = await startServer(() => 5);
      handle.registry.setDiscordWsConnected(true);

      const res = await fetch(`http://${HOST}:${handle.server.port}/health`, { method: "HEAD" });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.text()).toBe("");
    });

    it("returns 200 with empty body on HEAD /metrics", async () => {
      handle = await startServer(() => 5);

      const res = await fetch(`http://${HOST}:${handle.server.port}/metrics`, { method: "HEAD" });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
      expect(await res.text()).toBe("");
    });
  });

  describe("query strings", () => {
    it("ignores query strings on /health", async () => {
      handle = await startServer(() => 9);

      const res = await fetch(`http://${HOST}:${handle.server.port}/health?ts=12345`);
      expect(res.status).toBe(200);
    });
  });
});

describe("health-metrics config", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    // Snapshot the env so we can restore between tests.
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  // Lazy import to keep the describe block self-contained.
  it("defaults HEALTH_PORT to 8080 and HEALTH_HOST to 127.0.0.1", async () => {
    delete process.env.HEALTH_PORT;
    delete process.env.HEALTH_HOST;
    const { readHealthMetricsConfig } = await import(
      "../src/features/health-metrics/config.js"
    );
    expect(readHealthMetricsConfig(process.env)).toEqual({ port: 8080, host: "127.0.0.1" });
  });

  it("honors HEALTH_PORT and HEALTH_HOST overrides", async () => {
    process.env.HEALTH_PORT = "9090";
    process.env.HEALTH_HOST = "0.0.0.0";
    const { readHealthMetricsConfig } = await import(
      "../src/features/health-metrics/config.js"
    );
    expect(readHealthMetricsConfig(process.env)).toEqual({ port: 9090, host: "0.0.0.0" });
  });

  it("rejects invalid HEALTH_PORT values", async () => {
    const { readHealthMetricsConfig } = await import(
      "../src/features/health-metrics/config.js"
    );
    expect(() => readHealthMetricsConfig({ ...process.env, HEALTH_PORT: "not-a-number" })).toThrow(
      /Invalid HEALTH_PORT/,
    );
    expect(() => readHealthMetricsConfig({ ...process.env, HEALTH_PORT: "-1" })).toThrow(
      /Invalid HEALTH_PORT/,
    );
    expect(() => readHealthMetricsConfig({ ...process.env, HEALTH_PORT: "99999" })).toThrow(
      /Invalid HEALTH_PORT/,
    );
  });
});
