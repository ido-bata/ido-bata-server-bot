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

/**
 * Reads HEALTH_PORT / HEALTH_HOST from the environment.
 *
 * - HEALTH_PORT defaults to 8080. Port 0 is allowed (ephemeral) for tests.
 * - HEALTH_HOST defaults to 127.0.0.1 — the metrics endpoint is intentionally
 *   not bound to a public interface. Operators should front it with a
 *   sidecar/proxy if external scraping is required.
 */
export function readHealthMetricsConfig(
  env: NodeJS.ProcessEnv,
  options: ReadHealthMetricsConfigOptions = {},
): HealthMetricsConfig {
  const portRaw = env.HEALTH_PORT;
  const port = portRaw === undefined ? options.defaultPort ?? DEFAULT_PORT : Number.parseInt(portRaw, 10);

  if (!Number.isFinite(port) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid HEALTH_PORT: ${portRaw ?? ""}`);
  }

  const host = env.HEALTH_HOST ?? options.defaultHost ?? DEFAULT_HOST;
  return { port, host };
}
