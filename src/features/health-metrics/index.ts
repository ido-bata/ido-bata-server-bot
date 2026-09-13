import type { Client } from "discord.js";
import { Events } from "discord.js";

import { getActiveTimekeeperSessionCount } from "../timekeeper/service.js";
import { readHealthMetricsConfig, type HealthMetricsConfig } from "./config.js";
import { MetricsRegistry } from "./metrics.js";
import {
  createHealthMetricsServer,
  type HealthMetricsServerHandle,
} from "./server.js";

export type RegisterHealthMetricsOptions = {
  /** Override the parsed HEALTH_PORT/HEALTH_HOST config. */
  config?: HealthMetricsConfig;
  /** Inject a pre-built registry (used by tests). */
  registry?: MetricsRegistry;
  /**
   * Disable the HTTP server. When true, only the registry is returned —
   * useful for unit tests that only need to read metrics without binding
   * a port.
   */
  disableServer?: boolean;
};

export type HealthMetricsRegistration = {
  registry: MetricsRegistry;
  config: HealthMetricsConfig;
  handle: HealthMetricsServerHandle | null;
};

/**
 * Wires the health/metrics feature into the bot process:
 *
 * 1. Creates a `MetricsRegistry` and subscribes to Discord gateway
 *    events to keep `bot_discord_ws_connected` in sync (event-driven,
 *    not polled — see issue #26 "Dependencies & blockers").
 * 2. Periodically refreshes `bot_timekeeper_active_sessions` by reading
 *    the timekeeper module's session count.
 * 3. Starts the HTTP server on the configured port (default 8080,
 *    bound to 127.0.0.1).
 *
 * Returns the registry so callers can record command invocations from
 * other features (slash-command handlers, timekeeper-commands, etc.).
 */
export async function registerHealthMetrics(
  client: Client,
  options: RegisterHealthMetricsOptions = {},
): Promise<HealthMetricsRegistration> {
  const config = options.config ?? readHealthMetricsConfig(process.env);
  const registry =
    options.registry ??
    new MetricsRegistry({
      // No additional deps — defaults read process.uptime() lazily.
    });

  attachDiscordGatewayListeners(client, registry);
  attachTimekeeperSessionPoller(registry);

  let handle: HealthMetricsServerHandle | null = null;
  if (!options.disableServer) {
    handle = await createHealthMetricsServer({
      host: config.host,
      port: config.port,
      registry,
    });
    console.log(`Health/metrics server listening on http://${config.host}:${handle.port}`);
  }

  return { registry, config, handle };
}

function attachDiscordGatewayListeners(client: Client, registry: MetricsRegistry): void {
  // Start in disconnected state — we only flip to "connected" once we see
  // a ready event from the gateway. This avoids a false-positive health
  // reading during the boot phase before ClientReady fires.
  registry.setDiscordWsConnected(false);

  client.on(Events.ClientReady, () => {
    registry.setDiscordWsConnected(true);
  });

  // Shard-level events cover the case where the process is reconnecting
  // to the gateway after a network blip; we treat "reconnecting" as
  // disconnected from the metrics surface's perspective.
  client.on(Events.ShardDisconnect, () => {
    registry.setDiscordWsConnected(false);
  });
  client.on(Events.ShardReconnecting, () => {
    registry.setDiscordWsConnected(false);
  });
  client.on(Events.ShardError, () => {
    registry.setDiscordWsConnected(false);
  });
}

/**
 * The timekeeper service exposes a getter rather than an event, so we
 * poll it lightly. 1Hz is enough — sessions last minutes, and the
 * /metrics scrape interval is usually 15–60s.
 */
function attachTimekeeperSessionPoller(registry: MetricsRegistry): void {
  const refresh = () => {
    registry.setTimekeeperActiveSessions(getActiveTimekeeperSessionCount());
  };
  refresh();
  const timer = setInterval(refresh, 1000);
  // Don't keep the event loop alive just for this poller — let the
  // process exit naturally when Discord disconnects.
  timer.unref();
}
