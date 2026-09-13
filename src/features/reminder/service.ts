import { randomUUID } from "node:crypto";

import type { Client, DMChannel, User } from "discord.js";
import { Events } from "discord.js";

import { executeRemindCommand, type RemindCommandDeps } from "./command.js";
import { reminderConfig } from "./config.js";
import { type ReminderFire, pickNextFire, pickOverdueReminders } from "./scheduler.js";
import {
  type LoadOptions,
  loadReminders,
  type PersistedReminder,
  saveReminders,
} from "./store.js";

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

const defaultLogger: Logger = {
  info: (message) => console.log(`[reminder] ${message}`),
  warn: (message) => console.warn(`[reminder] ${message}`),
  error: (message) => console.error(`[reminder] ${message}`),
};

export type AddReminderInput = {
  userId: string;
  message: string;
  fireAt: Date;
  createdAt?: Date;
};

export type AddReminderResult =
  | { ok: true; reminder: PersistedReminder }
  | { ok: false; error: string };

export type DmSurface = {
  send: (body: string) => Promise<unknown>;
};

export type OpenDm = (userId: string) => Promise<DmSurface | null>;

export type ReminderQueueOptions = {
  loadOptions?: LoadOptions;
  now?: () => Date;
  logger?: Logger;
  /**
   * Override the sleep/wait between scheduler ticks. Tests can return
   * immediately; production uses `setTimeout`.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Resolve a target user into a sending surface. Falls back to
   * `client.users.fetch(...).createDM()` when not provided.
   */
  openDm?: OpenDm;
};

export type ReminderQueue = {
  add: (input: AddReminderInput) => AddReminderResult;
  countForUser: (userId: string) => number;
  list: () => PersistedReminder[];
  /**
   * Manually trigger one scan + dispatch pass. Tests use this instead of
   * relying on the timer; production calls it from the scheduler loop.
   */
  tick: () => Promise<void>;
  /**
   * Surface the next fire for diagnostics and tests.
   */
  getNextFire: () => ReminderFire | null;
  sendImmediateDm: (reminder: PersistedReminder) => Promise<{ delivered: boolean }>;
  start: () => void;
  stop: () => void;
};

const SCAN_INTERVAL_MS = 30_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function defaultOpenDm(client: Client, userId: string): Promise<DmSurface | null> {
  try {
    const user: User | null = await client.users.fetch(userId);
    if (!user) {
      return null;
    }
    const channel = (await user.createDM()) as DMChannel;
    return { send: (body: string) => channel.send(body) };
  } catch {
    return null;
  }
}

export function createReminderQueue(
  client: Client,
  options: ReminderQueueOptions = {},
): ReminderQueue {
  const nowFn = options.now ?? (() => new Date());
  const logger = options.logger ?? defaultLogger;
  const sleep = options.sleep ?? defaultSleep;
  const loadOptions = options.loadOptions ?? {};

  const initial = loadReminders(loadOptions);
  let reminders: PersistedReminder[] = [...initial.reminders];
  let stopped = false;
  let loopPromise: Promise<void> | null = null;

  function persist(): void {
    try {
      saveReminders(reminders, loadOptions);
    } catch (error) {
      logger.error(`Failed to persist reminder state: ${stringifyError(error)}`);
    }
  }

  function add(input: AddReminderInput): AddReminderResult {
    const message = input.message.trim();
    if (message.length === 0) {
      return { ok: false, error: "message is empty" };
    }
    if (Number.isNaN(input.fireAt.getTime())) {
      return { ok: false, error: "fireAt is invalid" };
    }

    const now = nowFn();
    const createdAt = input.createdAt ?? now;
    if (input.fireAt.getTime() <= now.getTime()) {
      return { ok: false, error: "fireAt must be in the future" };
    }

    if (input.fireAt.getTime() - now.getTime() > reminderConfig.maxDurationMs) {
      return { ok: false, error: "fireAt exceeds maximum allowed duration" };
    }

    if (countForUser(input.userId) >= reminderConfig.maxPerUser) {
      return { ok: false, error: "per-user reminder limit reached" };
    }

    const reminder: PersistedReminder = {
      id: randomUUID(),
      userId: input.userId,
      message,
      fireAt: input.fireAt.toISOString(),
      createdAt: createdAt.toISOString(),
    };

    reminders = [...reminders, reminder];
    persist();
    return { ok: true, reminder };
  }

  function countForUser(userId: string): number {
    return reminders.filter((reminder) => reminder.userId === userId).length;
  }

  function list(): PersistedReminder[] {
    return [...reminders];
  }

  async function sendImmediateDm(
    reminder: PersistedReminder,
  ): Promise<{ delivered: boolean }> {
    const body = buildReminderBody(reminder);
    const surface = options.openDm
      ? await options.openDm(reminder.userId)
      : await defaultOpenDm(client, reminder.userId);

    if (!surface) {
      return { delivered: false };
    }

    await surface.send(body);
    return { delivered: true };
  }

  async function dispatch(fires: ReminderFire[]): Promise<void> {
    if (fires.length === 0) {
      return;
    }

    const completed: string[] = [];

    for (const fire of fires) {
      try {
        const result = await sendImmediateDm(fire.reminder);
        if (!result.delivered) {
          logger.warn(
            `Could not deliver reminder ${fire.reminder.id} to user ${fire.reminder.userId} (DM disabled?)`,
          );
          continue;
        }

        logger.info(
          `Fired reminder ${fire.reminder.id} for user ${fire.reminder.userId} (scheduled ${fire.fireAt.toISOString()})`,
        );
        completed.push(fire.reminder.id);
      } catch (error) {
        logger.error(
          `Failed to dispatch reminder ${fire.reminder.id}: ${stringifyError(error)}`,
        );
      }
    }

    if (completed.length > 0) {
      const completedSet = new Set(completed);
      reminders = reminders.filter((reminder) => !completedSet.has(reminder.id));
      persist();
    }
  }

  async function tick(): Promise<void> {
    const now = nowFn();
    const overdue = pickOverdueReminders(reminders, now);
    await dispatch(overdue);
  }

  async function loop(): Promise<void> {
    // First tick happens immediately so any reminders that became overdue while
    // the bot was offline get a chance to fire on the next event-loop turn.
    while (!stopped) {
      try {
        await tick();
      } catch (error) {
        logger.error(`Scheduler iteration failed: ${stringifyError(error)}`);
      }

      const next = pickNextFire(reminders, nowFn());
      const delayMs = next
        ? Math.max(SCAN_INTERVAL_MS, next.fireAt.getTime() - nowFn().getTime())
        : SCAN_INTERVAL_MS;

      await sleep(delayMs);
    }
  }

  return {
    add,
    countForUser,
    list,
    tick,
    getNextFire: () => pickNextFire(reminders, nowFn()),
    async sendImmediateDm(reminder) {
      return sendImmediateDm(reminder);
    },
    start() {
      if (loopPromise) {
        return;
      }
      logger.info(`Loaded ${reminders.length} reminder(s) from ${initial.filePath}`);
      loopPromise = loop();
    },
    stop() {
      stopped = true;
    },
  };
}

function buildReminderBody(reminder: PersistedReminder): string {
  const firedAt = new Date();
  return [
    "⏰ リマインド",
    `登録時刻 (JST): ${formatJstDate(new Date(reminder.createdAt))}`,
    `発火予定 (JST): ${formatJstDate(new Date(reminder.fireAt))}`,
    `現在の時刻 (JST): ${formatJstDate(firedAt)}`,
    "",
    reminder.message,
  ].join("\n");
}

function formatJstDate(date: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function registerReminder(
  client: Client,
  options: ReminderQueueOptions = {},
): { queue: ReminderQueue } {
  let queue: ReminderQueue | null = null;
  let commandDeps: RemindCommandDeps | null = null;

  client.once(Events.ClientReady, () => {
    queue = createReminderQueue(client, options);
    commandDeps = {
      queue,
      now: options.now,
    };
    queue.start();
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "remind") {
      return;
    }
    if (!interaction.isRepliable()) {
      return;
    }

    if (!queue) {
      queue = createReminderQueue(client, options);
      commandDeps = {
        queue,
        now: options.now,
      };
    }
    if (!commandDeps) {
      return;
    }

    await executeRemindCommand(interaction as never, commandDeps);
  });

  return {
    get queue() {
      if (!queue) {
        queue = createReminderQueue(client, options);
        commandDeps = {
          queue,
          now: options.now,
        };
      }
      return queue;
    },
  };
}
