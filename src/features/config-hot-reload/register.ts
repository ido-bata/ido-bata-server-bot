import {
  ConfigStore,
  type ConfigStoreLogger,
  createFsWatcher,
  type FileWatcherFactory,
} from "./store.js";

/**
 * Default watcher factory backed by `createFsWatcher` (which delegates to
 * `node:fs.watch`). Exported so callers can compose it; tests inject their
 * own factory to avoid touching the filesystem.
 */
export function createFsWatcherFactory(): FileWatcherFactory {
  return (filePath, onChange) => createFsWatcher(filePath, onChange);
}

export const consoleConfigStoreLogger: ConfigStoreLogger = {
  info: (message, meta) => console.log(`[config-hot-reload] ${message}`, meta ?? ""),
  warn: (message, meta) => console.warn(`[config-hot-reload] ${message}`, meta ?? ""),
  error: (message, meta) => console.error(`[config-hot-reload] ${message}`, meta ?? ""),
};

export type RegisterConfigHotReloadOptions = {
  /** Absolute path to the runtime config file (typically `data/config.json`). */
  filePath: string;
  /** Override the default 1s debounce. Tests pass `0` or small values. */
  debounceMs?: number;
  /** Optional logger override (defaults to the console-backed logger). */
  logger?: ConfigStoreLogger;
  /** Inject a custom watcher factory (default uses `fs.watch`). */
  watcherFactory?: FileWatcherFactory;
};

/**
 * Start a ConfigStore against `data/config.json`. The returned ConfigStore is
 * already started (initial load + watch); the caller owns the lifecycle and
 * must call `.stop()` on shutdown.
 */
export function registerConfigHotReload(
  options: RegisterConfigHotReloadOptions,
): ConfigStore {
  const store = new ConfigStore({
    filePath: options.filePath,
    debounceMs: options.debounceMs,
    logger: options.logger ?? consoleConfigStoreLogger,
    watcherFactory: options.watcherFactory ?? createFsWatcherFactory(),
  });

  // `start()` performs the initial read asynchronously; we deliberately do
  // not await here so registration is non-blocking. Errors during the
  // initial read are routed through the error listeners.
  void store.start();

  return store;
}

export {
  ConfigStore,
  type ConfigStoreLogger,
  type ErrorListener,
  type FileWatcher,
  type FileWatcherFactory,
  type TimerFactory,
  type TimerHandle,
  type UpdateListener,
  createFsWatcher,
} from "./store.js";
export {
  type HotReloadConfig,
  hotReloadConfigSchema,
  parseHotReloadConfig,
  safeParseHotReloadConfig,
} from "./schema.js";
