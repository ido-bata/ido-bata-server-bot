import { createGuildRegistry, type GuildRegistry, type RegistryOptions } from "./registry.js";
import { type ConfigStore, type ConfigStoreOptions, createConfigStore } from "./store.js";

export type BootstrapOptions = {
  /** Storage backend holding the per-guild configuration. */
  driver?: ConfigStoreOptions["driver"];
  /** Storage key prefix that holds the per-guild configuration. */
  prefix?: string;
  /** Optional override for the registry (e.g. custom logger). */
  registryOptions?: Omit<RegistryOptions, "store">;
};

export type Bootstrap = {
  store: ConfigStore;
  registry: GuildRegistry;
};

/**
 * Construct the multi-guild stack (config store + registry) from defaults.
 * Tests can pass a memory storage driver; production callers get the
 * configured backend.
 */
export function bootstrapMultiGuild(options: BootstrapOptions = {}): Bootstrap {
  const store = createConfigStore({
    driver: options.driver,
    prefix: options.prefix,
  });
  const registry = createGuildRegistry({
    store,
    ...(options.registryOptions ?? {}),
  });
  return { store, registry };
}
