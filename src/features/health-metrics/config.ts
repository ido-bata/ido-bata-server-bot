export type HealthMetricsConfig = {
  port: number;
  host: string;
};

export type ReadHealthMetricsConfigOptions = {
  defaultPort?: number;
  defaultHost?: string;
};

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = "127.0.0.1";
/** Host a container must bind so a platform probe can reach the port from outside. */
const CONTAINER_HOST = "0.0.0.0";

/**
 * Reads HEALTH_PORT / HEALTH_HOST from the environment.
 *
 * - `HEALTH_PORT` defaults to 8080, then falls back to `PORT`. Hosting
 *   platforms (Altare included) assign the listening port through `PORT`;
 *   reading only `HEALTH_PORT` left the server bound to 8080 while the
 *   platform probed the port it had assigned, so every health check failed.
 *   Port 0 is allowed (ephemeral) for tests.
 * - `HEALTH_HOST` defaults to 127.0.0.1 on a bare-metal run — the metrics
 *   endpoint is intentionally not bound to a public interface. Inside a
 *   container (`CONTAINER=true`, set by the Containerfile and compose) the
 *   default is 0.0.0.0: a published/health-probed port is reached through
 *   the container's interface, never its loopback, so binding 127.0.0.1
 *   makes the exposed port unreachable. `HEALTH_HOST` still overrides both.
 */
export function readHealthMetricsConfig(
  env: NodeJS.ProcessEnv,
  options: ReadHealthMetricsConfigOptions = {},
): HealthMetricsConfig {
  const portRaw = env.HEALTH_PORT ?? env.PORT;
  const port =
    portRaw === undefined ? (options.defaultPort ?? DEFAULT_PORT) : Number.parseInt(portRaw, 10);

  if (!Number.isFinite(port) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid HEALTH_PORT: ${portRaw ?? ""}`);
  }

  const containerHost = isContainerEnv(env) ? CONTAINER_HOST : DEFAULT_HOST;
  const host = env.HEALTH_HOST ?? options.defaultHost ?? containerHost;
  return { port, host };
}

/** `CONTAINER` is set by the Containerfile / compose; treat any non-empty, non-"false" value as true. */
function isContainerEnv(env: NodeJS.ProcessEnv): boolean {
  const value = env.CONTAINER?.trim().toLowerCase();
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}
