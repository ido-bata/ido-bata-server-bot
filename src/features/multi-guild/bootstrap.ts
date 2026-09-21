import { createGuildRegistry, type GuildRegistry, type RegistryOptions } from "./registry.js";
import { type ConfigStore, createFileConfigStore, type FileSystemLike } from "./store.js";

export type BootstrapOptions = {
  /** Path to the data directory; defaults to "data". */
  dataRoot?: string;
  /** Filesystem-like for tests. */
  fs?: FileSystemLike;
  /** Optional override for the registry (e.g. custom logger). */
  registryOptions?: Omit<RegistryOptions, "store">;
};

export type Bootstrap = {
  store: ConfigStore;
  registry: GuildRegistry;
};

/**
 * Construct the multi-guild stack (config store + registry) from defaults.
 * Tests can pass a fake filesystem; production callers get a real one.
 */
export function bootstrapMultiGuild(options: BootstrapOptions = {}): Bootstrap {
  const store = createFileConfigStore({
    dataRoot: options.dataRoot,
    fs: options.fs,
  });
  const registry = createGuildRegistry({
    store,
    ...(options.registryOptions ?? {}),
  });
  return { store, registry };
}
