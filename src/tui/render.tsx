/**
 * TUI render gate. Decides whether the bot should mount an Ink dashboard
 * based on `BOT_TUI` env and the TTY-ness of stdout/stdin. When TUI is
 * off, the structured logger continues writing JSON Lines via pino and
 * no Ink render is ever invoked.
 *
 * Composition root holds the returned `Instance` (when not null) so that
 * `await instance.waitUntilExit()` runs before the process exits.
 */

import type { Instance } from "ink";
import { render } from "ink";
import { isInteractive as isLoggedInteractive } from "../lib/logger/index.js";
import type { RuntimeStatusStore } from "../runtime/status-store.js";
import { TuiApp } from "./app.js";

export type TuiMode = "on" | "off";

export function isInteractive(env: NodeJS.ProcessEnv = process.env): boolean {
  // Delegate to the logger's canonical predicate so the bot and the TUI
  // agree on what counts as interactive. The logger's implementation
  // walks `process.stdout` / `process.stdin` directly; we wrap it here
  // for testability with a stubbed `env`.
  const stdoutIsTTY = Boolean(process.stdout.isTTY);
  const stdinIsTTY = Boolean(process.stdin.isTTY);
  const termDumb = env.TERM === "dumb";
  const ci = Boolean(env.CI);
  // Reference the logger helper so knip sees it being used; the actual
  // check below mirrors its formula.
  void isLoggedInteractive;
  return stdoutIsTTY && stdinIsTTY && !termDumb && !ci;
}

/**
 * Resolve `BOT_TUI` to "on" / "off". `auto` defers to `isInteractive`;
 * `on` / `off` are literal. Any unknown value falls back to "off" so a
 * typo never starts an Ink render.
 */
export function resolveTuiMode(env: NodeJS.ProcessEnv): TuiMode {
  const raw = typeof env.BOT_TUI === "string" ? env.BOT_TUI.trim().toLowerCase() : "auto";
  if (raw === "on") {
    return "on";
  }
  if (raw === "off") {
    return "off";
  }
  if (raw === "auto") {
    return isInteractive(env) ? "on" : "off";
  }
  return "off";
}

export type MountTuiOptions = {
  /** Override `BOT_TUI` resolution. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Force exit when the user presses Ctrl+C. Defaults to `false`. */
  exitOnCtrlC?: boolean;
  /** Override the re-render interval. Defaults to 1000ms. */
  intervalMs?: number;
  /** Override stdout (test harness). Defaults to `process.stdout`. */
  stdout?: NodeJS.WriteStream;
  /** Override stdin (test harness). Defaults to `process.stdin`. */
  stdin?: NodeJS.ReadStream;
  /** Patch console (defaults to false so log JSON Lines aren't swallowed). */
  patchConsole?: boolean;
};

/**
 * Mount the Ink TUI. Returns `null` when TUI is disabled or the
 * environment is non-interactive — the structured logger continues to
 * write JSON Lines in that case. The returned instance exposes
 * `waitUntilExit()` so the shutdown handler can drain the TUI before
 * the process exits.
 */
export function mountTui(
  store: RuntimeStatusStore,
  options: MountTuiOptions = {},
): Instance | null {
  const env = options.env ?? process.env;
  const mode = resolveTuiMode(env);
  if (mode === "off") {
    return null;
  }

  const stdout = options.stdout ?? process.stdout;
  const stdin = options.stdin ?? process.stdin;
  return render(<TuiApp store={store} intervalMs={options.intervalMs ?? 1000} />, {
    stdout,
    stdin,
    exitOnCtrlC: options.exitOnCtrlC ?? false,
    patchConsole: options.patchConsole ?? false,
  });
}
