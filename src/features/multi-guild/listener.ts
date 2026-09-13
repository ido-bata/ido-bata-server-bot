import type { GuildConfig } from "./config.js";

export type GuildContext = {
  guildId: string;
  config: GuildConfig;
};

/**
 * A listener is a piece of per-guild state that can be mounted/unmounted
 * dynamically as guilds are added, removed, or reconfigured.
 *
 * The registry owns the lifecycle: `onMount` is invoked once when a guild
 * becomes active, `onUnmount` is invoked when the guild is removed or its
 * config changes. Implementations must be idempotent — `onUnmount` may be
 * called even when `onMount` previously failed.
 */
export type GuildListener = {
  readonly id: string;
  onMount?(ctx: GuildContext): void | Promise<void>;
  onUnmount?(ctx: Pick<GuildContext, "guildId">): void | Promise<void>;
};

export type ListenerRegistration = {
  id: string;
  mount: (ctx: GuildContext) => Promise<void>;
  unmount: (ctx: Pick<GuildContext, "guildId">) => Promise<void>;
};

export type ListenerFactory = (registration: ListenerRegistration) => GuildListener;
