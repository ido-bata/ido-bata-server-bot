import type { Client } from "discord.js";
import { ChannelType, Events } from "discord.js";

import {
  type LoadOptions,
  loadScheduledAnnouncements,
  type ScheduledAnnouncementEntry,
  saveScheduledAnnouncements,
} from "./config.js";
import { getNextFireTime, pickNextFires, type ScheduledFire } from "./schedule.js";

type SendableTextChannel = {
  send: (content: string) => Promise<unknown>;
};

export type ChannelResolver = (channelId: string) => Promise<SendableTextChannel | null>;

type SendResult = "sent" | "retry" | "failed";

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

const defaultLogger: Logger = {
  info: (message) => console.log(`[scheduled-announcements] ${message}`),
  warn: (message) => console.warn(`[scheduled-announcements] ${message}`),
  error: (message) => console.error(`[scheduled-announcements] ${message}`),
};

type ServiceOptions = {
  loadOptions?: LoadOptions;
  resolveChannel?: ChannelResolver;
  logger?: Logger;
  /**
   * Sleep hook used by retry logic; tests inject an instant resolver.
   */
  sleep?: (ms: number) => Promise<void>;
};

export type ScheduledAnnouncementsService = {
  start: () => void;
  stop: () => void;
  /**
   * Compute the next fire that will run, mostly for diagnostics and tests.
   */
  getNextFire: () => ScheduledFire | null;
  /**
   * Return the entries currently tracked (with any persisted state changes
   * applied, e.g. one-shot auto-disable).
   */
  getEntries: () => ScheduledAnnouncementEntry[];
};

const RETRY_DELAY_MS = 5_000;
const MAX_RETRY_ATTEMPTS = 2;

export function createScheduledAnnouncementsService(
  client: Client,
  options: ServiceOptions = {},
): ScheduledAnnouncementsService {
  const logger = options.logger ?? defaultLogger;
  const sleep = options.sleep ?? defaultSleep;
  const initial = loadScheduledAnnouncements(options.loadOptions ?? {});
  let entries: ScheduledAnnouncementEntry[] = [...initial.entries];
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  function resolveChannel(channelId: string): Promise<SendableTextChannel | null> {
    if (options.resolveChannel) {
      return options.resolveChannel(channelId);
    }

    return client.channels
      .fetch(channelId)
      .then((channel) => {
        if (!channel) return null;
        if (channel.type === ChannelType.GuildCategory) return null;
        if (!channel.isTextBased() || !("send" in channel)) return null;
        return channel as unknown as SendableTextChannel;
      })
      .catch((error: unknown) => {
        logger.warn(`Failed to resolve channel ${channelId}: ${stringifyError(error)}`);
        return null;
      });
  }

  function persist(): void {
    try {
      saveScheduledAnnouncements(entries, options.loadOptions ?? {});
    } catch (error) {
      logger.error(`Failed to persist state: ${stringifyError(error)}`);
    }
  }

  async function sendWithRetry(fire: ScheduledFire): Promise<SendResult> {
    let attempt = 0;
    let lastError: unknown = null;

    while (attempt < MAX_RETRY_ATTEMPTS) {
      attempt += 1;
      const channel = await resolveChannel(fire.entry.channelId);
      if (!channel) {
        lastError = new Error(`Channel not found: ${fire.entry.channelId}`);
        logger.warn(
          `Attempt ${attempt}/${MAX_RETRY_ATTEMPTS} failed for ${fire.entry.id}: ${stringifyError(lastError)}`,
        );
        if (attempt < MAX_RETRY_ATTEMPTS) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        return "failed";
      }

      try {
        await channel.send(fire.entry.message);
        return "sent";
      } catch (error) {
        lastError = error;
        logger.warn(
          `Attempt ${attempt}/${MAX_RETRY_ATTEMPTS} failed for ${fire.entry.id}: ${stringifyError(error)}`,
        );
        if (attempt < MAX_RETRY_ATTEMPTS) {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }

    logger.error(`Giving up on entry ${fire.entry.id}: ${stringifyError(lastError)}`);
    return "failed";
  }

  function scheduleNext(): void {
    if (stopped) {
      return;
    }

    const now = new Date();
    const next = pickNextFires(entries, now, 1)[0] ?? null;

    if (!next) {
      logger.info("No enabled entries left to schedule; entering idle loop.");
      // Re-check periodically so config edits followed by a restart can be
      // picked up; also handles a future case where entries get re-enabled
      // via edit-and-restart.
      timer = setTimeout(scheduleNext, 60_000);
      return;
    }

    const delayMs = Math.max(0, next.fireAt.getTime() - now.getTime());
    logger.info(
      `Next entry ${next.entry.id} scheduled for ${next.fireAt.toISOString()} (in ${Math.round(delayMs / 1000)}s)`,
    );
    timer = setTimeout(() => {
      void fire(next).finally(scheduleNext);
    }, delayMs);
  }

  async function fire(target: ScheduledFire): Promise<void> {
    const result = await sendWithRetry(target);

    if (result === "sent") {
      logger.info(`Fired entry ${target.entry.id} (${target.fireAt.toISOString()})`);
    }

    const entryIndex = entries.findIndex((candidate) => candidate.id === target.entry.id);
    const entry = entryIndex === -1 ? target.entry : entries[entryIndex]!;

    if (entry.oneShotDate) {
      if (result === "sent" || result === "failed") {
        const reason =
          result === "sent"
            ? "one-shot completed"
            : `one-shot failed after ${MAX_RETRY_ATTEMPTS} attempts`;
        const updated: ScheduledAnnouncementEntry = { ...entry, enabled: false };
        entries =
          entryIndex === -1
            ? [...entries, updated]
            : entries.map((candidate) => (candidate.id === entry.id ? updated : candidate));
        logger.info(`One-shot ${entry.id} finished (${reason})`);
        persist();
      }
      return;
    }

    if (result === "failed") {
      // For weekly entries we still keep them on the schedule; only a one-shot
      // that fails twice is auto-disabled.
      logger.warn(`Weekly entry ${entry.id} will retry on its next weekly cadence.`);
    }
  }

  return {
    start() {
      if (timer || stopped) {
        return;
      }

      logger.info(`Loaded ${entries.length} scheduled-announcements entries`);
      for (const entry of entries) {
        const next = getNextFireTime(entry, new Date());
        logger.info(
          `  - ${entry.id} enabled=${entry.enabled} weekday=${entry.weekday ?? "-"} oneShotDate=${entry.oneShotDate ?? "-"} ${pad2(entry.hour)}:${pad2(entry.minute)} next=${next ? next.toISOString() : "(none)"}`,
        );
      }
      scheduleNext();
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    getNextFire: () => pickNextFires(entries, new Date(), 1)[0] ?? null,
    getEntries: () => [...entries],
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

/**
 * Compatibility wrapper that mirrors the registration style of the timekeeper
 * feature: pass the discord.js Client, the service gets registered on
 * `ClientReady` so we don't race against channel cache warm-up.
 */
export function registerScheduledAnnouncements(
  client: Client,
  options: ServiceOptions = {},
): ScheduledAnnouncementsService {
  let service: ScheduledAnnouncementsService | null = null;

  client.once(Events.ClientReady, () => {
    service = createScheduledAnnouncementsService(client, options);
    service.start();
  });

  return {
    start() {
      service?.start();
    },
    stop() {
      service?.stop();
    },
    getNextFire: () => service?.getNextFire() ?? null,
    getEntries: () => service?.getEntries() ?? [],
  };
}
