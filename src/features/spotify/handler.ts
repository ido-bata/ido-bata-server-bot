import type { SpotifyActivityShape, SpotifyTrack } from "./activity.js";
import { parseSpotifyActivity } from "./activity.js";
import {
  type NowPlayingEmbedContent,
  type NowPlayingListener,
  type StopReason,
  formatNowPlayingEmbed,
} from "./formatter.js";
import type { StoredNowPlaying, NowPlayingStore } from "./state.js";

export type PresenceUpdateInput = {
  userId: string;
  guildId: string | null;
  displayName: string;
  activities: ReadonlyArray<SpotifyActivityShape | null | undefined> | null | undefined;
};

export type SendEmbedFn = (
  userId: string,
  embed: NowPlayingEmbedContent,
  target: NowPlayingListener,
) => Promise<string | null>;

export type EditEmbedFn = (
  userId: string,
  messageId: string,
  embed: NowPlayingEmbedContent,
) => Promise<void>;

export type DeleteEmbedFn = (userId: string, messageId: string) => Promise<void>;

export type NowPlayingHandlerDependencies = {
  store: NowPlayingStore;
  sendEmbed?: SendEmbedFn;
  editEmbed?: EditEmbedFn;
  deleteEmbed?: DeleteEmbedFn;
  now?: () => number;
};

export type NowPlayingHandlerResult =
  | { kind: "none" }
  | { kind: "started"; entry: StoredNowPlaying }
  | { kind: "updated"; entry: StoredNowPlaying }
  | { kind: "removed"; entry: StoredNowPlaying; reason: StopReason };

export type SpotifyNowPlayingHandler = {
  onPresenceUpdate: (input: PresenceUpdateInput) => Promise<NowPlayingHandlerResult>;
  pruneStale: () => Promise<NowPlayingHandlerResult[]>;
  stopFor: (userId: string, reason: StopReason) => Promise<NowPlayingHandlerResult | null>;
};

export function createSpotifyNowPlayingHandler(
  deps: NowPlayingHandlerDependencies,
): SpotifyNowPlayingHandler {
  const store = deps.store;
  const sendEmbed = deps.sendEmbed;
  const editEmbed = deps.editEmbed;
  const deleteEmbed = deps.deleteEmbed;
  const now = deps.now ?? (() => Date.now());

  function listenerFor(input: PresenceUpdateInput): NowPlayingListener {
    return { userId: input.userId, displayName: input.displayName };
  }

  async function start(
    input: PresenceUpdateInput,
    track: SpotifyTrack,
    listener: NowPlayingListener,
  ): Promise<NowPlayingHandlerResult> {
    const existing = store.get(input.userId);
    const timestamp = now();

    if (existing && store.isSameTrack(existing, track)) {
      const refreshed: StoredNowPlaying = {
        ...existing,
        displayName: input.displayName,
        lastUpdatedAt: timestamp,
      };
      store.set(refreshed);
      return { kind: "updated", entry: refreshed };
    }

    let embedMessageId: string | null = existing?.embedMessageId ?? null;
    const embed = formatNowPlayingEmbed(track, listener);

    if (embedMessageId && editEmbed) {
      try {
        await editEmbed(input.userId, embedMessageId, embed);
      } catch {
        embedMessageId = null;
      }
    }
    if (!embedMessageId && sendEmbed) {
      embedMessageId = await sendEmbed(input.userId, embed, listener);
    }

    const entry: StoredNowPlaying = {
      userId: input.userId,
      guildId: input.guildId ?? existing?.guildId ?? "",
      displayName: input.displayName,
      track,
      embedMessageId,
      lastUpdatedAt: timestamp,
    };
    store.set(entry);

    return { kind: "started", entry };
  }

  async function remove(
    entry: StoredNowPlaying,
    reason: StopReason,
  ): Promise<NowPlayingHandlerResult> {
    store.delete(entry.userId);
    if (entry.embedMessageId && deleteEmbed) {
      await deleteEmbed(entry.userId, entry.embedMessageId).catch(() => undefined);
    }
    return { kind: "removed", entry, reason };
  }

  async function onPresenceUpdate(
    input: PresenceUpdateInput,
  ): Promise<NowPlayingHandlerResult> {
    const track = parseSpotifyActivity(input.activities);

    if (!track) {
      const existing = store.get(input.userId);
      if (!existing) {
        return { kind: "none" };
      }
      const refreshed: StoredNowPlaying = {
        ...existing,
        displayName: input.displayName,
      };
      return remove(refreshed, "ended");
    }

    const listener = listenerFor(input);
    return start(input, track, listener);
  }

  async function pruneStale(): Promise<NowPlayingHandlerResult[]> {
    const stale = store.pruneStale(now());
    if (deleteEmbed) {
      for (const entry of stale) {
        if (entry.embedMessageId) {
          await deleteEmbed(entry.userId, entry.embedMessageId).catch(() => undefined);
        }
      }
    }
    return stale.map((entry) => ({ kind: "removed", entry, reason: "stale" as const }));
  }

  async function stopFor(
    userId: string,
    reason: StopReason,
  ): Promise<NowPlayingHandlerResult | null> {
    const existing = store.get(userId);
    if (!existing) {
      return null;
    }
    return remove(existing, reason);
  }

  return { onPresenceUpdate, pruneStale, stopFor };
}

// Re-exports for tests / public surface
export { parseSpotifyActivity, isSpotifyActivity } from "./activity.js";
export { formatNowPlayingEmbed, formatStoppedEmbed } from "./formatter.js";
export { NowPlayingStore, type StoredNowPlaying } from "./state.js";
export type { SpotifyTrack, SpotifyActivityShape } from "./activity.js";
export type { NowPlayingEmbedContent, NowPlayingListener, StopReason } from "./formatter.js";