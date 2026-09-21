import { randomUUID } from "node:crypto";

import type { Client, DMChannel, User } from "discord.js";
import { Events } from "discord.js";
import type { ConsentScope } from "../../consent/scopes.js";
import type { ConsentService } from "../../consent/service.js";
import { childFor, getRootLogger } from "../../lib/logger/index.js";
import { executeRemindCommand, type RemindCommandDeps } from "./command.js";
import { reminderConfig } from "./config.js";
import { pickNextFire, pickOverdueReminders, type ReminderFire } from "./scheduler.js";
import { type LoadOptions, loadReminders, type PersistedReminder, saveReminders } from "./store.js";

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

const reminderLogger = childFor(getRootLogger(), "reminder");

const defaultLogger: Logger = {
  info: (message) => reminderLogger.info(message),
  warn: (message) => reminderLogger.warn(message),
  error: (message) => reminderLogger.error(message),
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

/**
 * Convenience adapter: wrap a `ConsentService` in the gate shape the
 * reminder queue expects. Kept module-local so tests can build a fake
 * without importing the consent subsystem.
 */
export function toReminderConsentGate(
  service: ConsentService,
): Required<ReminderQueueOptions>["consent"] {
  return {
    authorize: async (subjectId, scope) => {
      const decision = await service.authorize(subjectId, scope);
      return { ok: decision.ok };
    },
  };
}

type DmSurface = {
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
  /**
   * v0.2.0: consent-gate reminder persistence. The gate runs BEFORE any
   * `saveReminders` call. If absent, the queue remains functional but every
   * `add` returns `consent-denied` — fail-closed.
   */
  consent?: {
    authorize: (subjectId: string, scope: ConsentScope) => Promise<{ ok: boolean }>;
  };
};

export type ReminderQueue = {
  add: (input: AddReminderInput) => AddReminderResult | Promise<AddReminderResult>;
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
  const loadOptions = options.loadOptions ?? {};

  const initial = loadReminders(loadOptions);
  let reminders: PersistedReminder[] = [...initial.reminders];
  let stopped = false;
  let loopPromise: Promise<void> | null = null;
  // Aborts the in-flight scheduler sleep so add()/stop() can wake the loop
  // immediately instead of waiting up to SCAN_INTERVAL_MS for the next tick.
  let sleepAbortController: AbortController | null = null;

  function persist(): void {
    try {
      saveReminders(reminders, loadOptions);
    } catch (error) {
      logger.error(`Failed to persist reminder state: ${stringifyError(error)}`);
    }
  }

  function wakeScheduler(): void {
    sleepAbortController?.abort();
  }

  function interruptibleSleep(ms: number): Promise<void> {
    if (ms <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const ac = new AbortController();
      sleepAbortController = ac;
      const timer = setTimeout(() => {
        ac.signal.removeEventListener("abort", onAbort);
        if (sleepAbortController === ac) {
          sleepAbortController = null;
        }
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        if (sleepAbortController === ac) {
          sleepAbortController = null;
        }
        resolve();
      };
      ac.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function add(input: AddReminderInput): AddReminderResult | Promise<AddReminderResult> {
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

    // v0.2.0: the consent gate runs synchronously *before* we mutate the
    // in-memory queue. If no gate is configured we fail closed: every
    // reminder is denied so the operator must wire the gate explicitly
    // when enabling the consent subsystem.
    if (!options.consent) {
      return { ok: false, error: "consent gate not configured" };
    }
    const gate = options.consent;
    return gate.authorize(input.userId, "activity-history").then((decision) => {
      if (!decision.ok) {
        return { ok: false, error: "consent denied" } satisfies AddReminderResult;
      }
      reminders = [...reminders, reminder];
      persist();
      wakeScheduler();
      return { ok: true, reminder } satisfies AddReminderResult;
    });
  }

  function countForUser(userId: string): number {
    return reminders.filter((reminder) => reminder.userId === userId).length;
  }

  function list(): PersistedReminder[] {
    return [...reminders];
  }

  async function sendImmediateDm(reminder: PersistedReminder): Promise<{ delivered: boolean }> {
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
        logger.error(`Failed to dispatch reminder ${fire.reminder.id}: ${stringifyError(error)}`);
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
      const remainingMs = next
        ? Math.max(0, next.fireAt.getTime() - nowFn().getTime())
        : Number.POSITIVE_INFINITY;
      // Cap the wait at SCAN_INTERVAL_MS so a far-future reminder (or an
      // empty queue) cannot block newly added earlier reminders for hours.
      const delayMs = Math.min(SCAN_INTERVAL_MS, remainingMs);

      await interruptibleSleep(delayMs);
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
      // Wake the scheduler so the loop exits promptly instead of waiting up
      // to SCAN_INTERVAL_MS for the in-flight sleep to resolve on its own.
      wakeScheduler();
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
