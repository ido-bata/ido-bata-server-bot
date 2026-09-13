import type { GuildConfig } from "./config.js";
import type { GuildContext, GuildListener } from "./listener.js";
import type { ConfigStore } from "./store.js";

export type RegistryEvent =
  | { kind: "guild-added"; guildId: string }
  | { kind: "guild-removed"; guildId: string }
  | { kind: "guild-reloaded"; guildId: string }
  | { kind: "listener-registered"; id: string }
  | { kind: "listener-unregistered"; id: string };

export type RegistryEventListener = (event: RegistryEvent) => void;

export type RegistryOptions = {
  store: ConfigStore;
  /** When a guild mounts a listener, also subscribe to lifecycle events. */
  onEvent?: RegistryEventListener;
  /** Optional logger for diagnostics; defaults to console. */
  logger?: Pick<Console, "log" | "warn" | "error">;
};

export type GuildRegistry = {
  registerListener(listener: GuildListener): void;
  unregisterListener(id: string): void;
  listListeners(): string[];
  addGuild(guildId: string, config?: GuildConfig): Promise<void>;
  removeGuild(guildId: string): Promise<void>;
  reloadGuild(guildId: string): Promise<void>;
  listGuilds(): string[];
  getConfig(guildId: string): GuildConfig | null;
  shutdown(): Promise<void>;
  on(listener: RegistryEventListener): () => void;
};

export function createGuildRegistry(options: RegistryOptions): GuildRegistry {
  const listeners = new Map<string, GuildListener>();
  const mountedConfigs = new Map<string, GuildConfig>();
  const eventListeners = new Set<RegistryEventListener>();
  const logger = options.logger ?? console;

  function emit(event: RegistryEvent): void {
    for (const handler of eventListeners) {
      try {
        handler(event);
      } catch (error) {
        logger.error(`[multi-guild] event handler for ${event.kind} threw`, error);
      }
    }
  }

  async function mountForGuild(guildId: string, config: GuildConfig): Promise<void> {
    const ctx: GuildContext = { guildId, config };
    for (const [id, listener] of listeners) {
      try {
        await listener.onMount?.(ctx);
      } catch (error) {
        logger.error(`[multi-guild] listener ${id} failed to mount for ${guildId}`, error);
      }
    }
  }

  async function unmountForGuild(guildId: string): Promise<void> {
    for (const [id, listener] of listeners) {
      try {
        await listener.onUnmount?.({ guildId });
      } catch (error) {
        logger.error(`[multi-guild] listener ${id} failed to unmount for ${guildId}`, error);
      }
    }
  }

  return {
    registerListener(listener) {
      if (listeners.has(listener.id)) {
        throw new Error(`Listener already registered: ${listener.id}`);
      }
      listeners.set(listener.id, listener);
      emit({ kind: "listener-registered", id: listener.id });

      // Hot-apply: if the guild is already mounted, run onMount for the new listener.
      for (const [guildId, config] of mountedConfigs) {
        Promise.resolve(listener.onMount?.({ guildId, config })).catch((error) => {
          logger.error(
            `[multi-guild] late-mount of listener ${listener.id} for ${guildId} failed`,
            error,
          );
        });
      }
    },

    unregisterListener(id) {
      const listener = listeners.get(id);
      if (!listener) {
        return;
      }
      // Best-effort unmount across all mounted guilds before removing.
      for (const guildId of mountedConfigs.keys()) {
        Promise.resolve(listener.onUnmount?.({ guildId })).catch((error) => {
          logger.error(
            `[multi-guild] unmount of listener ${id} for ${guildId} during unregister failed`,
            error,
          );
        });
      }
      listeners.delete(id);
      emit({ kind: "listener-unregistered", id });
    },

    listListeners() {
      return [...listeners.keys()];
    },

    async addGuild(guildId, config) {
      if (mountedConfigs.has(guildId)) {
        // Already mounted; treat as reload so listeners pick up the latest config.
        return this.reloadGuild(guildId);
      }

      let resolved = config;
      if (!resolved) {
        resolved = await options.store.ensureGuild(guildId);
      } else {
        await options.store.saveGuild(resolved);
      }

      mountedConfigs.set(guildId, resolved);
      logger.log(`[multi-guild] guild added: ${guildId}`);
      await mountForGuild(guildId, resolved);
      emit({ kind: "guild-added", guildId });
    },

    async removeGuild(guildId) {
      if (!mountedConfigs.has(guildId)) {
        return;
      }
      await unmountForGuild(guildId);
      mountedConfigs.delete(guildId);
      logger.log(`[multi-guild] guild removed: ${guildId}`);
      emit({ kind: "guild-removed", guildId });
    },

    async reloadGuild(guildId) {
      const existing = mountedConfigs.get(guildId);
      if (!existing) {
        throw new Error(`Cannot reload guild that is not mounted: ${guildId}`);
      }
      const next = await options.store.loadGuild(guildId);
      await unmountForGuild(guildId);
      mountedConfigs.set(guildId, next);
      await mountForGuild(guildId, next);
      emit({ kind: "guild-reloaded", guildId });
    },

    listGuilds() {
      return [...mountedConfigs.keys()];
    },

    getConfig(guildId) {
      return mountedConfigs.get(guildId) ?? null;
    },

    async shutdown() {
      const guildIds = [...mountedConfigs.keys()];
      for (const guildId of guildIds) {
        await this.removeGuild(guildId);
      }
      listeners.clear();
    },

    on(handler) {
      eventListeners.add(handler);
      return () => eventListeners.delete(handler);
    },
  };
}
