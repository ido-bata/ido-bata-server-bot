import { existsSync, type FSWatcher, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { HotReloadConfig } from "./schema.js";
import { safeParseHotReloadConfig } from "./schema.js";

export type ConfigStoreLogger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

type UpdateListener = (config: HotReloadConfig, previous: HotReloadConfig) => void;
type ErrorListener = (error: Error, context: { filePath: string }) => void;

export type FileWatcher = {
  close: () => void;
};

export type FileWatcherFactory = (filePath: string, onChange: () => void) => FileWatcher;

export type TimerHandle = {
  clear: () => void;
};

export type TimerFactory = {
  schedule: (callback: () => void, delayMs: number) => TimerHandle;
};

export type ConfigStoreOptions = {
  filePath: string;
  debounceMs?: number;
  logger?: ConfigStoreLogger;
  watcherFactory?: FileWatcherFactory;
  timerFactory?: TimerFactory;
  initialConfig?: HotReloadConfig;
};

const DEFAULT_DEBOUNCE_MS = 1000;
const EMPTY_CONFIG: HotReloadConfig = {};

const defaultLogger: ConfigStoreLogger = {
  info: (message, meta) => console.log(`[config-hot-reload] ${message}`, meta ?? ""),
  warn: (message, meta) => console.warn(`[config-hot-reload] ${message}`, meta ?? ""),
  error: (message, meta) => console.error(`[config-hot-reload] ${message}`, meta ?? ""),
};

/**
 * Start a `fs.watch`-backed watcher that survives a missing target file.
 *
 * When `filePath` exists, the file is watched directly. When the file is
 * absent (the common "first run" case), the parent directory is watched
 * instead and events are filtered down to the target basename so we still
 * notice the file's first appearance without throwing ENOENT during startup.
 */
export function createFsWatcher(filePath: string, onChange: () => void): FileWatcher {
  const dir = dirname(filePath);
  const target = basename(filePath);
  let fileWatcher: FSWatcher | null = null;
  let parentWatcher: FSWatcher | null = null;

  const closeAll = (): void => {
    if (fileWatcher) {
      fileWatcher.close();
      fileWatcher = null;
    }
    if (parentWatcher) {
      parentWatcher.close();
      parentWatcher = null;
    }
  };

  const watchFile = (): FSWatcher => {
    const watcher = watch(filePath, () => onChange());
    watcher.on("error", (err) => {
      if (isMissingFileError(err) && fileWatcher === watcher) {
        watcher.close();
        fileWatcher = null;
        watchParent();
      }
    });
    return watcher;
  };

  const watchParent = (): FSWatcher => {
    const watcher = watch(dir, (_eventType, filename) => {
      // Linux sometimes passes `null` for filename; treat any event as a
      // possible hit and verify by checking the file's existence.
      if (filename !== null && filename !== target) {
        return;
      }
      onChange();
      if (!existsSync(filePath) || fileWatcher !== null) {
        return;
      }
      try {
        fileWatcher = watchFile();
        watcher.close();
        parentWatcher = null;
      } catch {
        // Still missing or not watchable; keep the parent watcher.
      }
    });
    return watcher;
  };

  if (existsSync(filePath)) {
    fileWatcher = watchFile();
  } else {
    parentWatcher = watchParent();
  }

  return { close: closeAll };
}

function defaultWatcherFactory(filePath: string, onChange: () => void): FileWatcher {
  return createFsWatcher(filePath, onChange);
}

function defaultTimerFactory(): TimerFactory {
  return {
    schedule(callback, delayMs) {
      const handle = setTimeout(callback, delayMs);
      return { clear: () => clearTimeout(handle) };
    },
  };
}

export class ConfigStore {
  private readonly filePath: string;
  private readonly debounceMs: number;
  private readonly logger: ConfigStoreLogger;
  private readonly watcherFactory: FileWatcherFactory;
  private readonly timerFactory: TimerFactory;

  private current: HotReloadConfig;
  private watcher: FileWatcher | null = null;
  private pending: TimerHandle | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly updateListeners = new Set<UpdateListener>();
  private readonly errorListeners = new Set<ErrorListener>();

  constructor(options: ConfigStoreOptions) {
    this.filePath = options.filePath;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.logger = options.logger ?? defaultLogger;
    this.watcherFactory = options.watcherFactory ?? defaultWatcherFactory;
    this.timerFactory = options.timerFactory ?? defaultTimerFactory();
    this.current = options.initialConfig ?? { ...EMPTY_CONFIG };
  }

  get(): HotReloadConfig {
    return { ...this.current };
  }

  onUpdate(listener: UpdateListener): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  async start(): Promise<void> {
    try {
      const initial = await this.readAndParse();
      this.current = initial;
      this.logger.info("loaded initial config", { filePath: this.filePath });
    } catch (error) {
      // Missing file on startup is not fatal — start with empty config and
      // continue watching; the first write will hydrate.
      if (isMissingFileError(error)) {
        this.logger.warn("config file missing at startup; starting with empty config", {
          filePath: this.filePath,
        });
      } else {
        this.logger.error("failed to read initial config", {
          filePath: this.filePath,
          error: errorMessage(error),
        });
        this.emitError(toError(error));
      }
    }

    this.watcher = this.watcherFactory(this.filePath, () => this.scheduleApply());
  }

  /**
   * Resolve when the currently in-flight `applyFromDisk` completes. Returns
   * immediately when no apply is running. Intended for tests; production
   * callers can simply listen to `onUpdate`/`onError`.
   */
  whenIdle(): Promise<void> {
    return this.inFlight ? this.inFlight.then(() => undefined) : Promise.resolve();
  }

  stop(): void {
    if (this.pending) {
      this.pending.clear();
      this.pending = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private scheduleApply(): void {
    if (this.pending) {
      this.pending.clear();
    }
    this.pending = this.timerFactory.schedule(() => {
      this.pending = null;
      this.inFlight = this.applyFromDisk();
      this.inFlight.finally(() => {
        if (this.inFlight) {
          this.inFlight = null;
        }
      });
    }, this.debounceMs);
  }

  private async applyFromDisk(): Promise<void> {
    try {
      const incoming = await this.readAndParse();
      const previous = this.current;
      // Partial merge: a write that only sets `auditLogChannelId` keeps
      // every other key from the previous snapshot. Moderators tweaking a
      // single channel ID should not have to re-supply the whole file.
      const next: HotReloadConfig = { ...previous, ...incoming };
      this.current = next;
      this.logger.info("applied hot-reloaded config", {
        filePath: this.filePath,
        changedKeys: diffKeys(previous, next),
      });
      for (const listener of this.updateListeners) {
        try {
          listener(next, previous);
        } catch (listenerError) {
          this.logger.error("update listener threw", { error: errorMessage(listenerError) });
        }
      }
    } catch (error) {
      this.logger.error("rejected config change; keeping previous snapshot", {
        filePath: this.filePath,
        error: errorMessage(error),
      });
      this.emitError(toError(error));
    }
  }

  private async readAndParse(): Promise<HotReloadConfig> {
    const raw = await readFile(this.filePath, "utf8");
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (parseError) {
      throw new Error(`invalid JSON in ${this.filePath}: ${errorMessage(parseError)}`, {
        cause: parseError,
      });
    }
    const result = safeParseHotReloadConfig(json);
    if (!result.ok) {
      throw new Error(`schema validation failed: ${result.error?.message ?? "unknown error"}`);
    }
    return result.data ?? {};
  }

  private emitError(error: Error): void {
    for (const listener of this.errorListeners) {
      try {
        listener(error, { filePath: this.filePath });
      } catch (listenerError) {
        this.logger.error("error listener threw", { error: errorMessage(listenerError) });
      }
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: string }).code;
  return code === "ENOENT";
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(errorMessage(value));
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function diffKeys(before: HotReloadConfig, after: HotReloadConfig): string[] {
  const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
  const beforeRecord = before as Record<string, unknown>;
  const afterRecord = after as Record<string, unknown>;
  const changed: string[] = [];
  for (const key of keys) {
    if (beforeRecord[key] !== afterRecord[key]) {
      changed.push(key);
    }
  }
  return changed.sort();
}
