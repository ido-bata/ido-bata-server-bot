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
/** Host to bind when the process is reached from outside (container / platform). */
const PUBLIC_HOST = "0.0.0.0";

/**
 * Reads HEALTH_PORT / HEALTH_HOST from the environment.
 *
 * - `PORT` wins over `HEALTH_PORT`. On App Hosting the platform proxy
 *   connects to the port in `PORT`, so a stale `HEALTH_PORT` (=8080, which
 *   the runbook used to instruct) must not shadow it: the app would listen
 *   on one port while the proxy dials another, and every request would
 *   return 502 even though the bot is running. `HEALTH_PORT` stays useful
 *   for a bare-metal run, where no `PORT` is assigned. Port 0 is allowed
 *   (ephemeral) for tests.
 * - `HEALTH_HOST` defaults to 127.0.0.1 on a bare-metal run — the metrics
 *   endpoint is intentionally not bound to a public interface. When the
 *   process is reachable from outside it must bind 0.0.0.0: a platform
 *   proxy connects over the host's interface, never its loopback, so
 *   127.0.0.1 makes the endpoint unreachable and the platform reports the
 *   app as down. "Reachable from outside" is `CONTAINER=true`
 *   (Containerfile / compose) or an assigned `PORT` (App Hosting), detected
 *   from the environment because a platform may start the app directly
 *   (`node dist/index.js`) without any container.
 *   `HEALTH_HOST` still overrides both.
 */
export function readHealthMetricsConfig(
  env: NodeJS.ProcessEnv,
  options: ReadHealthMetricsConfigOptions = {},
): HealthMetricsConfig {
  // PORT first: it is the platform's contract with its proxy.
  const portRaw = env.PORT ?? env.HEALTH_PORT;
  const port =
    portRaw === undefined ? (options.defaultPort ?? DEFAULT_PORT) : Number.parseInt(portRaw, 10);

  if (!Number.isFinite(port) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid health port: ${portRaw ?? ""} (from PORT / HEALTH_PORT)`);
  }

  const host = env.HEALTH_HOST ?? options.defaultHost ?? defaultHost(env);
  return { port, host };
}

/**
 * Pick the default bind address. A platform-assigned `PORT` is the signal
 * that an external proxy will connect, so binding loopback there is always
 * wrong; `CONTAINER` covers a container that assigns no port.
 */
function defaultHost(env: NodeJS.ProcessEnv): string {
  return hasValue(env.PORT) || isContainerEnv(env) ? PUBLIC_HOST : DEFAULT_HOST;
}

/** True when the variable is present and not an empty/false-y string. */
function hasValue(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed !== "" && trimmed !== "0" && trimmed !== "false";
}

/** `CONTAINER` is set by the Containerfile / compose. */
function isContainerEnv(env: NodeJS.ProcessEnv): boolean {
  return hasValue(env.CONTAINER);
}
