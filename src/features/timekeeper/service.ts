import { existsSync } from "node:fs";

import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import type { Client, GuildMember, VoiceBasedChannel } from "discord.js";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Events } from "discord.js";
import type { BotConfig } from "../../config.js";
import type { ConsentService } from "../../consent/service.js";
import { childFor, getRootLogger } from "../../lib/logger/index.js";
import { isTimekeeperConfigured, type TimekeeperConfig, timekeeperConfig } from "./config.js";

const logger = childFor(getRootLogger(), "timekeeper");

import {
  attachPersistenceAuthorization,
  buildCheckInCustomId,
  buildCheckInLabel,
  buildFortuneSummary,
  createSessionEngagement,
  getSessionCheckInCount,
  markSessionInterrupted,
  parseCheckInCustomId,
  persistSessionAttendance,
  recordCheckIn,
  type TimekeeperSessionEngagement,
} from "./engagement.js";
import type { PlaybackTimeouts } from "./playback-budget.js";
import { resolvePlaybackTimeouts } from "./playback-budget.js";
import {
  getCurrentOrNextDailyStartAt,
  getNextDailyStartAt,
  getTimekeeperPreparationStartAt,
} from "./schedule.js";
import {
  clampTimeToEvent,
  createSessionClock,
  findTimelineStartIndex,
  getDelayFor,
  getTimelineNow,
  type SessionClock,
} from "./session-clock.js";
import {
  buildProgressMessage,
  buildTimekeeperTimeline,
  type TimekeeperTimelineEvent,
} from "./timeline.js";
import { attachVoiceDebugging, logVoiceStateSnapshot } from "./voice-debug.js";

type EditableTextMessage = {
  edit: (content: string | { components?: unknown[]; content: string }) => Promise<unknown>;
};

type SendableTextChannel = {
  send: (
    content: string | { components?: unknown[]; content: string },
  ) => Promise<EditableTextMessage>;
};

type AnnouncementPlaybackResult = {
  progressTask: Promise<void> | null;
};

let activeSession: TimekeeperSessionEngagement | null = null;
let activeTimeline: TimekeeperTimelineEvent[] = [];
let activeClock: SessionClock | null = null;
let activePaused = false;
let activeSkipResolver: (() => void) | null = null;
let pendingScheduledStartAt: Date | null = null;
let skipFlag = false;
// Incremented every time a session run starts or is aborted. The event loop
// captures the value at start and aborts once it no longer matches, which is
// how the watchdog stops a wedged runSession without waiting for it to settle.
let sessionGeneration = 0;
// The in-flight voice connection, tracked at module level so the watchdog can
// destroy it when the owning runSession is wedged inside an unbounded await.
let activeVoiceConnection: Awaited<ReturnType<typeof connectForPlayback>> | null = null;

/**
 * Upper bound for each pre-flight step in `runSession` (channel resolution,
 * voice connect, engagement load). Discord REST / storage calls have no
 * built-in timeout; without this a wedged gateway leaves the session — and
 * therefore the whole daily scheduler — silently stuck forever.
 */
const PREFLIGHT_STEP_TIMEOUT_MS = 30_000;
/** Hard cap for the whole voice-connect sequence including stage retries. */
const VOICE_CONNECT_TIMEOUT_MS = 5 * 60_000;
/** Extra wall-clock allowed past the nominal session length before the watchdog fires. */
const SESSION_WATCHDOG_MARGIN_MS = 10 * 60_000;

/**
 * Snapshot of the currently running (or just-scheduled) timekeeper session.
 *
 * `pendingStartAt` is the daily start time of the next session we have
 * scheduled, even when no session is currently in-flight. `activeSessionId`
 * is non-null only while `runSession` is actively executing.
 */
export type TimekeeperSessionSnapshot = {
  activeSessionId: string | null;
  pendingStartAt: Date | null;
  paused: boolean;
};

/**
 * Public, read-only view of the timekeeper runtime state. Used by the
 * `/timekeeper` slash command module so it can render reply content
 * without needing to reach into private module state.
 */
export function getTimekeeperSessionSnapshot(): TimekeeperSessionSnapshot {
  return {
    activeSessionId: activeSession?.id ?? null,
    pendingStartAt: pendingScheduledStartAt,
    paused: activePaused,
  };
}

/**
 * Whether a session is currently in-flight. Returned as a plain boolean
 * for the slash-command module's DI seam. `false` when only a future session
 * is scheduled but not yet running.
 */
export function isTimekeeperSessionActive(): boolean {
  return activeSession !== null;
}

/**
 * Whether the currently running session is paused (phase-ending-soon events
 * are suppressed). Always `false` when no session is active.
 */
function isTimekeeperSessionPaused(): boolean {
  return activePaused && activeSession !== null;
}

/**
 * Pause the currently-running session. Returns `true` if a session was
 * active and was paused; `false` if no session is running.
 *
 * Paused sessions skip `phase-ending-soon` events but otherwise continue
 * their loop. Exported for the `/timekeeper pause` slash command.
 */
export function pauseTimekeeperSession(): boolean {
  if (!activeSession) {
    return false;
  }
  if (!activePaused) {
    activePaused = true;
    logger.info("session paused");
  }
  return true;
}

/**
 * Resume a paused session. Returns `true` if a session was paused and is
 * now running again, `false` if no session is active or it was not paused.
 */
export function resumeTimekeeperSession(): boolean {
  if (!activeSession || !activePaused) {
    return false;
  }
  activePaused = false;
  logger.info("session resumed");
  return true;
}

/**
 * Request the currently-running session to skip its current wait, advancing
 * to the next timeline event. Returns `true` when an active session picked
 * up the request; `false` otherwise.
 *
 * The skip is delivered through a one-shot resolver registered by the
 * session loop right before it awaits `delay()`. If the loop is not
 * currently awaiting (e.g. between events), the resolver is still pending
 * and will fire as soon as it is re-armed.
 */
export function requestTimekeeperSkip(): boolean {
  if (!activeSession) {
    return false;
  }
  if (activeSkipResolver) {
    const resolve = activeSkipResolver;
    activeSkipResolver = null;
    resolve();
  } else {
    skipFlag = true;
  }
  return true;
}

/**
 * Wait for `ms` milliseconds, or until `/timekeeper skip` is invoked.
 *
 * Used in place of a bare `delay()` so that a moderator's `/timekeeper skip`
 * can interrupt a multi-minute wait between events.
 */
function awaitInterruptibleDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (skipFlag) {
      skipFlag = false;
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      activeSkipResolver = null;
      resolve();
    }, ms);
    activeSkipResolver = () => {
      clearTimeout(timer);
      activeSkipResolver = null;
      resolve();
    };
  });
}

/** Test-only: reset all module-level state. Not exported from index.ts. */
export function __resetTimekeeperRuntimeState(): void {
  activeSession = null;
  activeTimeline = [];
  activeClock = null;
  activePaused = false;
  activeSkipResolver = null;
  pendingScheduledStartAt = null;
  skipFlag = false;
  sessionGeneration += 1;
  activeVoiceConnection = null;
}

/**
 * Cancel the in-progress timekeeper session if any. Persists whatever state
 * has been collected so far, marks the session as cancelled, and resets the
 * module-level singletons. Resolves with `true` if a session was cancelled.
 *
 * Safe to call when no session is active — it then resolves with `false`
 * and is a no-op. Used by the graceful-shutdown handler so a SIGINT/SIGTERM
 * does not silently drop an in-progress session.
 *
 * Async because `markSessionInterrupted` now awaits the consent-gated
 * `persistSessionAttendance` call.
 */
export async function cancelActiveSession(
  options: { reason?: string; status?: "cancelled" | "interrupted" } = {},
): Promise<boolean> {
  const session = activeSession;
  if (!session) {
    return false;
  }

  await markSessionInterrupted(session, {
    reason: options.reason ?? "shutdown",
    status: options.status ?? "interrupted",
  });

  // Invalidate any in-flight runSession so its event loop aborts at the next
  // generation check instead of continuing to play audio after cancellation.
  sessionGeneration += 1;
  const wedgedConnection = activeVoiceConnection;
  activeVoiceConnection = null;
  if (wedgedConnection) {
    safeDestroy(wedgedConnection);
  }

  resetSessionRuntimeState();
  pendingScheduledStartAt = null;
  return true;
}

/**
 * Clear the per-session runtime singletons without touching scheduler state
 * (`pendingScheduledStartAt` belongs to `scheduleNextSession`). Shared by the
 * normal session tail, cancellation, and the watchdog abort path.
 */
function resetSessionRuntimeState(): void {
  activeSession = null;
  activeTimeline = [];
  activeClock = null;
  activePaused = false;
  activeSkipResolver = null;
  skipFlag = false;
}

/**
 * Force-abort a session whose `runSession` promise has not settled within the
 * watchdog budget. Bumps the generation so the orphaned loop exits at its next
 * check, destroys the tracked voice connection to unblock any voice awaits,
 * persists the interrupted session when one exists, and resets module state so
 * the scheduler can arm the next day cleanly.
 */
async function abortWedgedSession(): Promise<void> {
  sessionGeneration += 1;

  const wedgedConnection = activeVoiceConnection;
  activeVoiceConnection = null;
  if (wedgedConnection) {
    safeDestroy(wedgedConnection);
  }

  const session = activeSession;
  if (session) {
    try {
      await markSessionInterrupted(session, {
        reason: "watchdog",
        status: "interrupted",
      });
    } catch (error) {
      logger.error({ err: error }, "failed to persist interrupted session during watchdog abort");
    }
  }

  resetSessionRuntimeState();
}

/**
 * Read-only accessor for the observability layer. Returns the number of
 * timekeeper sessions currently active in this process (0 or 1 — the
 * service runs a single session at a time). Exposed so the health/metrics
 * endpoints can report `bot_timekeeper_active_sessions` without poking
 * at module-level state directly.
 */
export function getActiveTimekeeperSessionCount(): number {
  return activeSession ? 1 : 0;
}

export function registerTimekeeper(
  client: Client,
  options: { botConfig: BotConfig; consentService?: ConsentService } = {
    botConfig: undefined as unknown as BotConfig,
  },
): {
  detachConsent: () => void;
} {
  const { botConfig } = options;
  let detachConsent: () => void = () => undefined;
  if (options.consentService) {
    detachConsent = attachPersistenceAuthorization(
      {
        authorize: async (subjectId, scope) => {
          const decision = await options.consentService!.authorize(subjectId, scope);
          return { ok: decision.ok };
        },
      },
      (listener) => options.consentService!.subscribe(listener),
    );
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) {
      return;
    }

    const parsed = parseCheckInCustomId(interaction.customId);
    if (!parsed || !activeSession || parsed.sessionId !== activeSession.id) {
      return;
    }

    const recorded = recordCheckIn(activeSession, interaction.user.id, parsed.order);
    const event = activeTimeline.find((entry) => entry.order === parsed.order);

    if (event && activeClock) {
      const updatedContent = buildProgressMessage(
        event,
        clampTimeToEvent(event, getTimelineNow(activeClock, Date.now())),
        getSessionCheckInCount(activeSession, event.order),
      );

      if (updatedContent) {
        await interaction.update({
          content: updatedContent,
          components: buildCheckInComponents(event),
        });
        return;
      }
    }

    await interaction.reply({
      content: recorded ? "確認を受け付けました。" : "このフェーズの確認はすでに済んでいます。",
      ephemeral: true,
    });
  });

  client.once(Events.ClientReady, () => {
    if (process.env.TIMEKEEPER_RUN_ON_READY === "true") {
      const now = new Date();
      const sessionStartAt = getCurrentOrNextDailyStartAt(
        now,
        timekeeperConfig.startHourJst,
        timekeeperConfig.startMinuteJst,
        timekeeperConfig.phases,
      );
      const startAt = isWithinSessionWindow(now, sessionStartAt, timekeeperConfig)
        ? sessionStartAt
        : now;

      logger.info(
        { startAt: startAt.toISOString() },
        "running timekeeper immediately because TIMEKEEPER_RUN_ON_READY=true",
      );
      void runSession(client, timekeeperConfig, botConfig, startAt).catch((error: unknown) => {
        logger.error({ err: error }, "immediate timekeeper session failed");
      });
      return;
    }

    scheduleNextSession(client, timekeeperConfig, botConfig);
  });

  return { detachConsent };
}

function scheduleNextSession(
  client: Client,
  config: TimekeeperConfig,
  botConfig: BotConfig,
  notBeforeStartAt: Date | null = null,
): void {
  if (!isTimekeeperConfigured(config)) {
    logger.warn(
      "Timekeeper is disabled. Set voiceChannelId and textChannelId in timekeeper config.",
    );
    pendingScheduledStartAt = null;
    return;
  }

  let nextStartAt = getCurrentOrNextDailyStartAt(
    new Date(),
    config.startHourJst,
    config.startMinuteJst,
    config.phases,
  );
  // A session that just ran (or failed) for `notBeforeStartAt` must not be
  // re-armed for the same slot: during the pre-start window the candidate
  // would be identical, producing a zero-delay hot loop of immediate
  // retries. Skipping to the next day keeps one attempt per day.
  if (notBeforeStartAt && nextStartAt.getTime() <= notBeforeStartAt.getTime()) {
    nextStartAt = getNextDailyStartAt(
      new Date(notBeforeStartAt.getTime() + 1),
      config.startHourJst,
      config.startMinuteJst,
    );
  }
  const preparationStartAt = getTimekeeperPreparationStartAt(nextStartAt);
  const delayMs = Math.max(0, preparationStartAt.getTime() - Date.now());
  pendingScheduledStartAt = nextStartAt;

  logger.info(
    {
      nextStartAt: nextStartAt.toISOString(),
      preparationStartAt: preparationStartAt.toISOString(),
    },
    "next timekeeper session scheduled",
  );

  const sessionBudgetMs = getSessionDurationMinutes(config) * 60_000;
  const watchdogMs = sessionBudgetMs + SESSION_WATCHDOG_MARGIN_MS;

  setTimeout(() => {
    logger.info(
      { startAt: nextStartAt.toISOString(), watchdogMs },
      "timekeeper session timer fired",
    );

    // Reschedule exactly once whether the session settles normally, throws,
    // or is force-aborted by the watchdog. Without this guard a wedged
    // runSession would leave the daily schedule permanently disarmed.
    let rescheduled = false;
    const rescheduleOnce = () => {
      if (rescheduled) {
        return;
      }
      rescheduled = true;
      pendingScheduledStartAt = null;
      scheduleNextSession(client, config, botConfig, nextStartAt);
    };

    const watchdog = setTimeout(() => {
      logger.error(
        { startAt: nextStartAt.toISOString(), watchdogMs },
        "timekeeper session watchdog expired; aborting wedged session",
      );
      void abortWedgedSession().then(rescheduleOnce, (error: unknown) => {
        logger.error({ err: error }, "watchdog abort failed; rescheduling anyway");
        rescheduleOnce();
      });
    }, watchdogMs);

    void runSession(client, config, botConfig, nextStartAt)
      .catch((error: unknown) => {
        logger.error({ err: error }, "timekeeper session failed");
      })
      .finally(() => {
        clearTimeout(watchdog);
        rescheduleOnce();
      });
  }, delayMs);
}

function getSessionDurationMinutes(config: TimekeeperConfig): number {
  return config.phases.reduce((total, phase) => total + phase.durationMinutes, 0);
}

function isWithinSessionWindow(now: Date, startAt: Date, config: TimekeeperConfig): boolean {
  const sessionEndAt = new Date(startAt.getTime() + getSessionDurationMinutes(config) * 60_000);
  return now >= startAt && now < sessionEndAt;
}

async function runSession(
  client: Client,
  config: TimekeeperConfig,
  botConfig: BotConfig,
  startAt: Date,
): Promise<void> {
  const generation = ++sessionGeneration;

  const voiceChannel = await withTimeout(
    resolveVoiceChannel(client, config.voiceChannelId),
    PREFLIGHT_STEP_TIMEOUT_MS,
    "resolve voice channel",
  );
  const textChannel = await withTimeout(
    resolveTextChannel(client, config.textChannelId),
    PREFLIGHT_STEP_TIMEOUT_MS,
    "resolve text channel",
  );

  if (!voiceChannel) {
    throw new Error(`Voice channel not found: ${config.voiceChannelId}`);
  }

  if (!textChannel) {
    throw new Error(`Text channel not found: ${config.textChannelId}`);
  }

  const connection = await connectWithTimeout(
    voiceChannel,
    client,
    botConfig.voiceConnectionTimeoutMs,
  );
  activeVoiceConnection = connection;

  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Pause,
    },
  });

  attachVoiceDebugging(connection, player);
  connection.subscribe(player);

  try {
    const timeline = buildTimekeeperTimeline(startAt, config);
    const now = new Date();
    const startIndex = findTimelineStartIndex(timeline, now);

    if (startIndex === -1) {
      logger.info("session has already ended; skipping playback");
      return;
    }

    const firstEvent = timeline[startIndex];
    if (firstEvent && firstEvent.at > now) {
      logger.info(
        { label: firstEvent.label, at: firstEvent.at.toISOString() },
        "starting from upcoming phase",
      );
    } else if (firstEvent) {
      logger.info(
        { label: firstEvent.label, startedAt: firstEvent.at.toISOString() },
        "resuming from current phase",
      );
    }

    activeTimeline = timeline;
    activeSession = await withTimeout(
      createSessionEngagement(startAt.toISOString()),
      PREFLIGHT_STEP_TIMEOUT_MS,
      "create session engagement",
    );

    const minuteMs = process.env.TIMEKEEPER_RUN_ON_READY === "true" ? 1_000 : 60_000;
    const clock = createSessionClock(timeline, startAt, startIndex, minuteMs, Date.now());
    activeClock = clock;
    const timelineNow = getTimelineNow(clock, Date.now());

    if (startIndex > 0) {
      await postMissedProgressMessages(textChannel, timeline, startIndex, timelineNow);
    }

    const progressTasks: Promise<void>[] = [];

    const eventsToRun = timeline.slice(startIndex);
    for (const [index, event] of eventsToRun.entries()) {
      const beforeWaitMs = Date.now();
      const waitMs = getDelayFor(clock, event.at, beforeWaitMs);
      logger.info(
        {
          order: event.order,
          kind: event.kind,
          scheduledAt: event.at.toISOString(),
          now: new Date(beforeWaitMs).toISOString(),
          waitMs,
        },
        "event waiting",
      );

      if (waitMs > 0) {
        await awaitInterruptibleDelay(waitMs);
      }

      // The watchdog (or a cancellation) bumps sessionGeneration while this
      // loop is suspended; bail out at the next event boundary instead of
      // continuing to play audio for a session that no longer owns the state.
      if (generation !== sessionGeneration) {
        logger.info({ order: event.order }, "session superseded; aborting event loop");
        return;
      }

      // A moderator-issued `/timekeeper skip` interrupts the wait above. If
      // the skip landed between this event's `at` and the next event's `at`,
      // treat that as a no-op for *this* iteration; the next loop iteration
      // will fire its event on schedule from its own `getDelayFor` call.

      if (isTimekeeperSessionPaused() && event.kind === "phase-ending-soon") {
        logger.info({ order: event.order }, "suppressing paused phase-ending-soon");
        continue;
      }

      const firedAtMs = Date.now();
      logger.info(
        {
          order: event.order,
          kind: event.kind,
          scheduledAt: event.at.toISOString(),
          actualAt: new Date(firedAtMs).toISOString(),
          latenessMs: firedAtMs - event.at.getTime(),
        },
        "event firing",
      );

      if (!existsSync(event.audioPath)) {
        throw new Error(`Audio file not found: ${event.audioPath}`);
      }

      // Bound this announcement to the time left before the next event, so a
      // stalled player cannot overrun the gap and make the next event fire
      // immediately after this one.
      const nextEvent = eventsToRun[index + 1];
      const msUntilNextEvent = nextEvent ? getDelayFor(clock, nextEvent.at, Date.now()) : null;

      const { progressTask } = await playAnnouncement(
        connection,
        client,
        voiceChannel,
        player,
        textChannel,
        event,
        clock,
        resolvePlaybackTimeouts(msUntilNextEvent),
        generation,
      );

      if (progressTask) {
        progressTasks.push(progressTask);
      }
    }

    await Promise.allSettled(progressTasks);
    if (activeSession) {
      await persistSessionAttendance(activeSession, formatSessionDate(startAt));
    }
    const fortuneSummaries = activeSession ? await buildFortuneSummary(activeSession) : null;
    if (fortuneSummaries) {
      for (const summary of fortuneSummaries) {
        await textChannel.send(summary);
      }
    }
  } finally {
    if (generation === sessionGeneration) {
      resetSessionRuntimeState();
      pendingScheduledStartAt = null;
    }
    activeVoiceConnection = null;
    safeDestroy(connection);
  }
}

/**
 * Reject `promise` after `ms` so an unbounded Discord REST / storage await
 * cannot wedge the session (and with it the daily scheduler) silently.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * `connectForPlayback` is internally bounded per attempt but its stage
 * prepare path still awaits Discord REST calls (suppress / members fetch)
 * that can hang. Cap the whole sequence; if the cap fires, destroy whatever
 * connection the abandoned attempt eventually produces.
 */
async function connectWithTimeout(
  voiceChannel: VoiceBasedChannel,
  client: Client,
  perAttemptTimeoutMs: number,
): Promise<Awaited<ReturnType<typeof connectForPlayback>>> {
  let expired = false;
  const connectionPromise = connectForPlayback(voiceChannel, client, perAttemptTimeoutMs).then(
    (connection) => {
      if (expired) {
        safeDestroy(connection);
      }
      return connection;
    },
  );

  try {
    return await withTimeout(connectionPromise, VOICE_CONNECT_TIMEOUT_MS, "voice connect");
  } catch (error) {
    expired = true;
    throw error;
  }
}

async function playAnnouncement(
  connection: Awaited<ReturnType<typeof connectForPlayback>>,
  client: Client,
  voiceChannel: VoiceBasedChannel,
  player: ReturnType<typeof createAudioPlayer>,
  textChannel: SendableTextChannel,
  event: TimekeeperTimelineEvent,
  clock: SessionClock,
  timeouts: PlaybackTimeouts,
  generation: number,
): Promise<AnnouncementPlaybackResult> {
  await refreshStageSpeakerBeforePlayback(client, voiceChannel);
  connection.setSpeaking(true);
  await delay(250);

  let progressTask: Promise<void> | null = null;
  const messageNow = clampTimeToEvent(event, getTimelineNow(clock, Date.now()));
  const initialMessage = buildProgressMessage(
    event,
    messageNow,
    activeSession ? getSessionCheckInCount(activeSession, event.order) : 0,
  );
  if (initialMessage) {
    const sentMessage = await textChannel.send({
      content: initialMessage,
      components: buildCheckInComponents(event),
    });
    progressTask = updateProgressMessage(sentMessage, event, clock, generation);
  }

  logger.info(
    {
      audioPath: event.audioPath,
      order: event.order,
      actualAt: new Date().toISOString(),
    },
    "playing audio",
  );
  const resource = createAudioResource(event.audioPath);
  player.play(resource);

  try {
    await entersState(player, AudioPlayerStatus.Playing, timeouts.startTimeoutMs);
    logger.info({ order: event.order }, "playing state reached");
  } catch {
    logger.error(
      { order: event.order, status: player.state.status },
      "failed to reach Playing state",
    );
  }

  try {
    await entersState(player, AudioPlayerStatus.Idle, timeouts.finishTimeoutMs);
    logger.info({ order: event.order }, "idle state reached");
  } catch {
    logger.error({ order: event.order, status: player.state.status }, "failed to reach Idle state");
  }

  connection.setSpeaking(false);
  player.stop();

  // Do not return progressTask directly from this async function. Async return
  // adopts returned promises, which would block the event loop until the whole
  // phase progress updater finishes and make the one-minute warning fire late.
  return { progressTask };
}

async function resolveVoiceChannel(
  client: Client,
  channelId: string,
): Promise<VoiceBasedChannel | null> {
  const channel = await client.channels.fetch(channelId);

  if (!channel?.isVoiceBased()) {
    return null;
  }

  return channel;
}

async function prepareStageSpeaker(voiceChannel: VoiceBasedChannel, client: Client): Promise<void> {
  if (voiceChannel.type !== ChannelType.GuildStageVoice) {
    return;
  }

  if (!client.user) {
    throw new Error("Bot user is not ready");
  }

  const botMember = await resolveBotMember(voiceChannel.guild, client.user.id);

  if (!botMember) {
    throw new Error("Bot member not found in guild");
  }

  try {
    await botMember.voice.setSuppressed(false);
    logger.info("stage speaker mode enabled by unsuppressing the bot");
  } catch (error) {
    logger.warn(
      { err: error },
      "failed to unsuppress bot in stage channel; requesting to speak instead",
    );
    await botMember.voice.setRequestToSpeak(true).catch(() => undefined);
    await delay(2_000);
  }

  await delay(1_000);
  await logVoiceStateSnapshot(botMember, voiceChannel, "after-stage-prepare");
}

const MAX_STAGE_RECONNECT_ATTEMPTS = 3;

export async function connectForPlayback(
  voiceChannel: VoiceBasedChannel,
  client: Client,
  timeoutMs: number,
) {
  let connection = await joinAndPrepare(voiceChannel, client, timeoutMs);

  if (voiceChannel.type !== ChannelType.GuildStageVoice) {
    return connection;
  }

  for (let attempt = 1; attempt <= MAX_STAGE_RECONNECT_ATTEMPTS; attempt++) {
    logger.info(
      { attempt, maxAttempts: MAX_STAGE_RECONNECT_ATTEMPTS },
      "stage channel reconnect attempt",
    );
    safeDestroy(connection);
    await delay(1_500);

    try {
      connection = await joinAndPrepare(voiceChannel, client, timeoutMs);
      logger.info(
        { attempt, maxAttempts: MAX_STAGE_RECONNECT_ATTEMPTS },
        "stage channel reconnected successfully",
      );
      return connection;
    } catch (error) {
      logger.error(
        { err: error, attempt, maxAttempts: MAX_STAGE_RECONNECT_ATTEMPTS },
        "stage channel reconnect attempt failed",
      );
      if (attempt === MAX_STAGE_RECONNECT_ATTEMPTS) {
        throw new Error(
          `Failed to connect to stage channel after ${MAX_STAGE_RECONNECT_ATTEMPTS} attempts`,
          { cause: error },
        );
      }
    }
  }

  throw new Error("Unexpected: stage reconnect loop exited without return");
}

async function joinAndPrepare(voiceChannel: VoiceBasedChannel, client: Client, timeoutMs: number) {
  const connection = joinVoiceChannel({
    guildId: voiceChannel.guild.id,
    channelId: voiceChannel.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, timeoutMs);
  } catch (error) {
    logger.error({ err: error, timeoutMs }, "voice connection timed out, destroying");
    connection.destroy();
    throw new Error(`Voice connection timed out after ${timeoutMs}ms`, { cause: error });
  }

  try {
    await prepareStageSpeaker(voiceChannel, client);
    await delay(1_000);

    if (client.user) {
      const botMember = await resolveBotMember(voiceChannel.guild, client.user.id);
      if (botMember) {
        await logVoiceStateSnapshot(botMember, voiceChannel, "after-join");
      }
    }
  } catch (error) {
    logger.error({ err: error }, "post-join setup failed, destroying voice connection");
    safeDestroy(connection);
    throw new Error("joinAndPrepare post-join setup failed", { cause: error });
  }

  return connection;
}

/**
 * Calls `connection.destroy()` while tolerating "already destroyed" failures.
 *
 * `@discordjs/voice` throws when `destroy()` is invoked on a connection that
 * has already been torn down. `joinAndPrepare` destroys the connection on its
 * own error paths (e.g. voice timeout), so when a stage-reconnect iteration
 * resumes after a failed `joinAndPrepare`, the connection tracked by the
 * caller has already been destroyed inside that helper. We swallow the
 * secondary destroy here so the loop can keep going without losing the real
 * cause of the failure.
 */
function safeDestroy(connection: Awaited<ReturnType<typeof joinAndPrepare>>): void {
  try {
    connection.destroy();
  } catch (error) {
    logger.warn(
      { err: error },
      "ignored error while destroying voice connection (already destroyed)",
    );
  }
}

async function resolveTextChannel(
  client: Client,
  channelId: string,
): Promise<SendableTextChannel | null> {
  const channel = await client.channels.fetch(channelId);

  if (!channel || channel.type === ChannelType.GuildCategory) {
    return null;
  }

  if (!channel.isTextBased() || !("send" in channel)) {
    return null;
  }

  return channel as SendableTextChannel;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function resolveBotMember(
  guild: VoiceBasedChannel["guild"],
  userId: string,
): Promise<GuildMember | null> {
  return guild.members.fetch(userId).catch(() => null);
}

async function refreshStageSpeakerBeforePlayback(
  client: Client,
  voiceChannel: VoiceBasedChannel,
): Promise<void> {
  if (voiceChannel.type !== ChannelType.GuildStageVoice || !client.user) {
    return;
  }

  const botMember = await resolveBotMember(voiceChannel.guild, client.user.id);

  if (!botMember) {
    return;
  }

  try {
    await botMember.voice.setSuppressed(false);
  } catch {
    logger.info("failed to unsuppress; requesting to speak");
    await botMember.voice.setRequestToSpeak(true).catch(() => undefined);
    await delay(2_000);
  }

  await delay(500);
  await logVoiceStateSnapshot(botMember, voiceChannel, "before-playback");
}

async function updateProgressMessage(
  message: EditableTextMessage,
  event: TimekeeperTimelineEvent,
  clock: SessionClock,
  generation: number,
): Promise<void> {
  if (!event.durationMinutes) {
    return;
  }

  const now = clampTimeToEvent(event, getTimelineNow(clock, Date.now()));
  const elapsedMinutes = getElapsedWholeMinutes(event, now);

  for (let minute = elapsedMinutes + 1; minute <= event.durationMinutes; minute += 1) {
    const targetAt = new Date(event.at.getTime() + minute * 60_000);
    const waitMs = getDelayFor(clock, targetAt, Date.now());
    if (waitMs > 0) {
      await delay(waitMs);
    }

    // Stop editing once the session has been superseded (watchdog abort or
    // cancellation); the orphaned updater must not keep writing to Discord.
    if (generation !== sessionGeneration) {
      return;
    }

    const nextMessage = buildProgressMessage(
      event,
      targetAt,
      activeSession ? getSessionCheckInCount(activeSession, event.order) : 0,
    );
    if (!nextMessage) {
      return;
    }

    await message.edit({
      content: nextMessage,
      components: minute === event.durationMinutes ? [] : buildCheckInComponents(event),
    });
  }
}

function buildCheckInComponents(event: TimekeeperTimelineEvent): ActionRowBuilder<ButtonBuilder>[] {
  if (!event.sendText || !activeSession) {
    return [];
  }

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildCheckInCustomId(activeSession.id, event.order))
        .setLabel(
          `${buildCheckInLabel(event.kind)} (${getSessionCheckInCount(activeSession, event.order)})`,
        )
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

function formatSessionDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function getElapsedWholeMinutes(event: TimekeeperTimelineEvent, now: Date): number {
  const elapsedMs = Math.max(0, now.getTime() - event.at.getTime());
  return Math.floor(elapsedMs / 60_000);
}

async function postMissedProgressMessages(
  textChannel: SendableTextChannel,
  timeline: TimekeeperTimelineEvent[],
  startIndex: number,
  now: Date,
): Promise<void> {
  const missedTextEvents = timeline.slice(0, startIndex).filter((event) => event.sendText);

  for (const event of missedTextEvents) {
    const effectiveNow = clampTimeToEvent(event, now);
    const content = buildProgressMessage(
      event,
      effectiveNow,
      activeSession ? getSessionCheckInCount(activeSession, event.order) : 0,
    );
    if (!content) {
      continue;
    }

    await textChannel.send({
      content,
      components: effectiveNow < (event.endAt ?? event.at) ? buildCheckInComponents(event) : [],
    });
  }
}
