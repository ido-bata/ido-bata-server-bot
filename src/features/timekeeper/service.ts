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

import { isTimekeeperConfigured, type TimekeeperConfig, timekeeperConfig } from "./config.js";
import {
  buildCheckInCustomId,
  buildCheckInLabel,
  buildFortuneSummary,
  createSessionEngagement,
  getSessionCheckInCount,
  parseCheckInCustomId,
  persistSessionAttendance,
  recordCheckIn,
  type TimekeeperSessionEngagement,
} from "./engagement.js";
import type { PlaybackTimeouts } from "./playback-budget.js";
import { resolvePlaybackTimeouts } from "./playback-budget.js";
import { getCurrentOrNextDailyStartAt, getTimekeeperPreparationStartAt } from "./schedule.js";
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
export function isTimekeeperSessionPaused(): boolean {
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
    console.log("[Timekeeper] Session paused");
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
  console.log("[Timekeeper] Session resumed");
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
export function awaitInterruptibleDelay(ms: number): Promise<void> {
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
}

export function registerTimekeeper(client: Client): void {
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

      console.log(
        `Running timekeeper immediately because TIMEKEEPER_RUN_ON_READY=true (startAt=${startAt.toISOString()})`,
      );
      void runSession(client, timekeeperConfig, startAt).catch((error: unknown) => {
        console.error("Immediate timekeeper session failed", error);
      });
      return;
    }

    scheduleNextSession(client, timekeeperConfig);
  });
}

function scheduleNextSession(client: Client, config: TimekeeperConfig): void {
  if (!isTimekeeperConfigured(config)) {
    console.warn(
      "Timekeeper is disabled. Set voiceChannelId and textChannelId in timekeeper config.",
    );
    pendingScheduledStartAt = null;
    return;
  }

  const nextStartAt = getCurrentOrNextDailyStartAt(
    new Date(),
    config.startHourJst,
    config.startMinuteJst,
    config.phases,
  );
  const preparationStartAt = getTimekeeperPreparationStartAt(nextStartAt);
  const delayMs = Math.max(0, preparationStartAt.getTime() - Date.now());
  pendingScheduledStartAt = nextStartAt;

  console.log(
    `Next timekeeper session scheduled for ${nextStartAt.toISOString()} (preparation starts at ${preparationStartAt.toISOString()})`,
  );

  setTimeout(() => {
    void runSession(client, config, nextStartAt)
      .catch((error: unknown) => {
        console.error("Timekeeper session failed", error);
      })
      .finally(() => {
        pendingScheduledStartAt = null;
        scheduleNextSession(client, config);
      });
  }, delayMs);
}

function isWithinSessionWindow(now: Date, startAt: Date, config: TimekeeperConfig): boolean {
  const totalDurationMinutes = config.phases.reduce(
    (total, phase) => total + phase.durationMinutes,
    0,
  );
  const sessionEndAt = new Date(startAt.getTime() + totalDurationMinutes * 60_000);
  return now >= startAt && now < sessionEndAt;
}

async function runSession(client: Client, config: TimekeeperConfig, startAt: Date): Promise<void> {
  const voiceChannel = await resolveVoiceChannel(client, config.voiceChannelId);
  const textChannel = await resolveTextChannel(client, config.textChannelId);

  if (!voiceChannel) {
    throw new Error(`Voice channel not found: ${config.voiceChannelId}`);
  }

  if (!textChannel) {
    throw new Error(`Text channel not found: ${config.textChannelId}`);
  }

  const connection = await connectForPlayback(voiceChannel, client);

  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Pause,
    },
  });

  attachVoiceDebugging(connection, player);
  connection.subscribe(player);

  const timeline = buildTimekeeperTimeline(startAt, config);
  const now = new Date();
  const startIndex = findTimelineStartIndex(timeline, now);

  if (startIndex === -1) {
    console.log("Session has already ended; skipping playback.");
    connection.destroy();
    return;
  }

  const firstEvent = timeline[startIndex];
  if (firstEvent && firstEvent.at > now) {
    console.log(
      `[Timekeeper] Starting from upcoming phase: ${firstEvent.label} (at ${firstEvent.at.toISOString()})`,
    );
  } else if (firstEvent) {
    console.log(
      `[Timekeeper] Resuming from current phase: ${firstEvent.label} (started at ${firstEvent.at.toISOString()})`,
    );
  }

  activeTimeline = timeline;
  activeSession = createSessionEngagement(startAt.toISOString());

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
    console.log(
      `[Timekeeper] Event waiting: order=${event.order}, kind=${event.kind}, scheduledAt=${event.at.toISOString()}, now=${new Date(beforeWaitMs).toISOString()}, waitMs=${waitMs}`,
    );

    if (waitMs > 0) {
      await awaitInterruptibleDelay(waitMs);
    }

    // A moderator-issued `/timekeeper skip` interrupts the wait above. If
    // the skip landed between this event's `at` and the next event's `at`,
    // treat that as a no-op for *this* iteration; the next loop iteration
    // will fire its event on schedule from its own `getDelayFor` call.

    if (isTimekeeperSessionPaused() && event.kind === "phase-ending-soon") {
      console.log(`[Timekeeper] Suppressing paused phase-ending-soon: order=${event.order}`);
      continue;
    }

    const firedAtMs = Date.now();
    console.log(
      `[Timekeeper] Event firing: order=${event.order}, kind=${event.kind}, scheduledAt=${event.at.toISOString()}, actualAt=${new Date(firedAtMs).toISOString()}, latenessMs=${firedAtMs - event.at.getTime()}`,
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
    );

    if (progressTask) {
      progressTasks.push(progressTask);
    }
  }

  await Promise.allSettled(progressTasks);
  if (activeSession) {
    persistSessionAttendance(activeSession, formatSessionDate(startAt));
  }
  const fortuneSummaries = activeSession ? await buildFortuneSummary(activeSession) : null;
  if (fortuneSummaries) {
    for (const summary of fortuneSummaries) {
      await textChannel.send(summary);
    }
  }
  activeSession = null;
  activeTimeline = [];
  activeClock = null;
  activePaused = false;
  activeSkipResolver = null;
  skipFlag = false;
  connection.destroy();
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
    progressTask = updateProgressMessage(sentMessage, event, clock);
  }

  console.log(
    `[Timekeeper] Playing: ${event.audioPath} (order=${event.order}, actualAt=${new Date().toISOString()})`,
  );
  const resource = createAudioResource(event.audioPath);
  player.play(resource);

  try {
    await entersState(player, AudioPlayerStatus.Playing, timeouts.startTimeoutMs);
    console.log(`[Timekeeper] Playing state reached: order=${event.order}`);
  } catch {
    console.error(
      `[Timekeeper] Failed to reach Playing state: order=${event.order}, status=${player.state.status}`,
    );
  }

  try {
    await entersState(player, AudioPlayerStatus.Idle, timeouts.finishTimeoutMs);
    console.log(`[Timekeeper] Idle state reached: order=${event.order}`);
  } catch {
    console.error(
      `[Timekeeper] Failed to reach Idle state: order=${event.order}, status=${player.state.status}`,
    );
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
    console.log("Stage speaker mode enabled by unsuppressing the bot.");
  } catch (error) {
    console.warn("Failed to unsuppress bot in stage channel. Requesting to speak instead.", error);
    await botMember.voice.setRequestToSpeak(true).catch(() => undefined);
    await delay(2_000);
  }

  await delay(1_000);
  await logVoiceStateSnapshot(botMember, voiceChannel, "after-stage-prepare");
}

async function connectForPlayback(voiceChannel: VoiceBasedChannel, client: Client) {
  let connection = await joinAndPrepare(voiceChannel, client);

  if (voiceChannel.type !== ChannelType.GuildStageVoice) {
    return connection;
  }

  // Stage channels can fail to relay audio immediately after the first join.
  // Reconnecting after unsuppressing the bot is a practical workaround.
  console.log("Reconnecting stage channel once before playback.");
  connection.destroy();
  await delay(1_500);

  connection = await joinAndPrepare(voiceChannel, client);
  return connection;
}

async function joinAndPrepare(voiceChannel: VoiceBasedChannel, client: Client) {
  const connection = joinVoiceChannel({
    guildId: voiceChannel.guild.id,
    channelId: voiceChannel.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  await prepareStageSpeaker(voiceChannel, client);
  await delay(1_000);

  if (client.user) {
    const botMember = await resolveBotMember(voiceChannel.guild, client.user.id);
    if (botMember) {
      await logVoiceStateSnapshot(botMember, voiceChannel, "after-join");
    }
  }

  return connection;
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
    console.log("Failed to unsuppress, requesting to speak...");
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
