import { EventEmitter } from "node:events";

import type { VoiceConnection } from "@discordjs/voice";
import * as voice from "@discordjs/voice";
import type { Client } from "discord.js";
import { ChannelType, Events } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetTimekeeperRuntimeState,
  getTimekeeperSessionSnapshot,
  registerTimekeeper,
} from "../src/features/timekeeper/service.js";

// The scheduler under test is module-private; drive it through the public
// registerTimekeeper + ClientReady path with a fake client, exactly like the
// composition root does in production.
vi.mock("@discordjs/voice", () => ({
  AudioPlayerStatus: {
    AutoPaused: "autopaused",
    Buffering: "buffering",
    Idle: "idle",
    Paused: "paused",
    Playing: "playing",
  },
  createAudioPlayer: vi.fn(() => ({
    play: vi.fn(),
    state: { status: "idle" },
    stop: vi.fn(),
  })),
  createAudioResource: vi.fn(() => ({})),
  entersState: vi.fn(),
  joinVoiceChannel: vi.fn(),
  NoSubscriberBehavior: { Pause: "pause" },
  VoiceConnectionStatus: {
    Destroyed: "destroyed",
    Ready: "ready",
    Signalling: "signalling",
  },
}));

// Voice-state snapshots pull extra Discord REST calls; stub the debug hooks so
// the test only exercises the scheduler/session lifecycle.
vi.mock("../src/features/timekeeper/voice-debug.js", () => ({
  attachVoiceDebugging: vi.fn(),
  logVoiceStateSnapshot: vi.fn(),
}));

// Engagement persistence would hit the storage driver (real fs I/O cannot
// complete inside fake-time advancement, tripping the pre-flight timeout);
// stub both entry points so tests exercise only the scheduler/session loop.
vi.mock("../src/features/timekeeper/engagement.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createSessionEngagement: vi.fn((id: string) =>
      Promise.resolve({
        attendanceDatesByUserId: new Map(),
        checkInsByUserId: new Map(),
        driver: {} as never,
        id,
      }),
    ),
    markSessionInterrupted: vi.fn(() => Promise.resolve()),
  };
});

const mockedJoinVoiceChannel = vi.mocked(voice.joinVoiceChannel);
const mockedEntersState = vi.mocked(voice.entersState) as unknown as ReturnType<
  typeof vi.fn<(target: unknown, status: unknown, timeoutMs?: number) => Promise<void>>
>;

function buildFakeClient(options: { hangChannelFetch?: boolean } = {}): Client {
  const emitter = new EventEmitter();
  // timekeeperConfig uses the same channel id for voice and text; a single
  // dual-purpose fake satisfies both resolvers for any fetched id.
  const channel = {
    guild: {
      id: "guild-id",
      members: { fetch: vi.fn(() => Promise.resolve(null)) },
      voiceAdapterCreator: () => ({}) as never,
    },
    id: "channel-id",
    isTextBased: () => true,
    isVoiceBased: () => true,
    send: vi.fn(() => Promise.resolve({ edit: vi.fn(() => Promise.resolve()) })),
    type: ChannelType.GuildVoice,
  };

  const fetch = vi.fn(() => {
    if (options.hangChannelFetch) {
      return new Promise(() => {});
    }
    return Promise.resolve(channel);
  });

  return Object.assign(emitter, {
    channels: { fetch },
    user: { id: "bot-user-id" },
  }) as unknown as Client;
}

function buildVoiceConnection(): VoiceConnection {
  return {
    destroy: vi.fn(),
    setSpeaking: vi.fn(),
    subscribe: vi.fn(),
  } as unknown as VoiceConnection;
}

const botConfig = { voiceConnectionTimeoutMs: 5_000 } as never;

beforeEach(() => {
  mockedJoinVoiceChannel.mockReset();
  mockedEntersState.mockReset();
  __resetTimekeeperRuntimeState();
  vi.useFakeTimers();
  // Anchor the clock so the next 21:00 JST session is ~2h away: a short,
  // deterministic schedule delay instead of up to ~24h.
  vi.setSystemTime(new Date("2026-11-22T10:00:00Z")); // 19:00 JST
});

afterEach(() => {
  vi.useRealTimers();
  __resetTimekeeperRuntimeState();
});

/** Flush microtasks between timer advances. */
async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await Promise.resolve();
}

describe("timekeeper scheduler resilience", () => {
  it("reschedules the next day when a pre-flight REST call hangs", async () => {
    // Reproduces the production wedge: channels.fetch never settles (zombie
    // gateway). The pre-flight timeout must fail the session loudly AND the
    // scheduler must arm the following day instead of stopping forever.
    const client = buildFakeClient({ hangChannelFetch: true });
    registerTimekeeper(client, { botConfig });
    (client as unknown as EventEmitter).emit(Events.ClientReady);
    await tick(0);

    expect(getTimekeeperSessionSnapshot().pendingStartAt?.toISOString()).toBe(
      "2026-11-22T12:00:00.000Z",
    );

    // Advance past the schedule delay (prep starts 20:57 JST = 11:57Z), then
    // past the 30s pre-flight timeout that rejects the wedged fetch.
    await tick(118 * 60_000);
    await tick(60_000);

    expect(getTimekeeperSessionSnapshot().pendingStartAt?.toISOString()).toBe(
      "2026-11-23T12:00:00.000Z",
    );
    // The session never reached the voice layer.
    expect(mockedJoinVoiceChannel).not.toHaveBeenCalled();
  });

  it("watchdog aborts a wedged session and re-arms the daily schedule", async () => {
    const connection = buildVoiceConnection();
    mockedJoinVoiceChannel.mockReturnValue(connection);
    // Voice connect resolves; the audio player's Idle transition never does,
    // so playAnnouncement stays suspended inside the session — the exact
    // shape of an unbounded await the watchdog exists for.
    mockedEntersState.mockImplementation((_target: unknown, status: unknown) =>
      status === "idle" ? new Promise<void>(() => {}) : Promise.resolve(),
    );

    const client = buildFakeClient();
    registerTimekeeper(client, { botConfig });
    (client as unknown as EventEmitter).emit(Events.ClientReady);
    await tick(0);

    // Fire the scheduled session (prep 11:57Z, start 12:00Z).
    await tick(118 * 60_000);
    // Let the first event reach the wedged Idle wait.
    await tick(5 * 60_000);
    expect(mockedJoinVoiceChannel).toHaveBeenCalledTimes(1);

    // Session budget is 100min + 10min margin; push past the watchdog.
    await tick(115 * 60_000);

    // The wedged connection must be destroyed and the schedule re-armed for
    // the next day — this is the assertion that would have caught the
    // production incident.
    expect(connection.destroy as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    expect(getTimekeeperSessionSnapshot().pendingStartAt?.toISOString()).toBe(
      "2026-11-23T12:00:00.000Z",
    );

    // ~22h later the re-armed timer must fire a second session.
    await tick(23 * 60 * 60_000);
    expect(mockedJoinVoiceChannel).toHaveBeenCalledTimes(2);
  });
});
