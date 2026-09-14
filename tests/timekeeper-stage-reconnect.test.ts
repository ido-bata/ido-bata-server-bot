import type { VoiceConnection } from "@discordjs/voice";
import * as voice from "@discordjs/voice";
import type { Client, VoiceBasedChannel } from "discord.js";
import { ChannelType } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectForPlayback } from "../src/features/timekeeper/service.js";

// Mock @discordjs/voice so connectForPlayback sees a fully controlled join
// sequence without touching any real Discord gateway. We keep the surface
// narrow because that is what service.ts uses.
vi.mock("@discordjs/voice", () => ({
  entersState: vi.fn(),
  joinVoiceChannel: vi.fn(),
  VoiceConnectionStatus: { Ready: "ready", Destroyed: "destroyed", Signalling: "signalling" },
}));

// Mirror ChannelType.GuildStageVoice so the production code routes into the
// reconnect branch. The real value is fine to use directly, but pinning it
// here documents intent and keeps the test resilient to a Discord library
// churn.
const STAGE_CHANNEL_TYPE = ChannelType.GuildStageVoice as unknown as VoiceBasedChannel["type"];

function buildStageChannel(): VoiceBasedChannel {
  return {
    id: "stage-channel-id",
    type: STAGE_CHANNEL_TYPE,
    guild: {
      id: "guild-id",
      voiceAdapterCreator: () => ({}) as never,
      members: { fetch: vi.fn(() => Promise.resolve(buildBotMember())) },
    },
  } as unknown as VoiceBasedChannel;
}

function buildBotMember() {
  return {
    guild: { id: "guild-id" },
    voice: {
      setSuppressed: vi.fn(() => Promise.resolve()),
      setRequestToSpeak: vi.fn(() => Promise.resolve()),
      channelId: "stage-channel-id",
      suppress: false,
      serverMute: false,
      selfMute: false,
      serverDeaf: false,
      selfDeaf: false,
      requestToSpeakTimestamp: null,
      sessionId: "session-id",
    },
    fetch: vi.fn(() => Promise.resolve()),
  };
}

function buildVoiceConnection(): VoiceConnection {
  return {
    destroy: vi.fn(),
  } as unknown as VoiceConnection;
}

function buildClient(): Client {
  return { user: { id: "bot-user-id" } } as unknown as Client;
}

// Cast to a single-arity mock because vi.mocked inherits the union overloads
// of entersState, which include an AudioPlayer signature that doesn't apply
// to the connection-only path under test.
const mockedJoinVoiceChannel = vi.mocked(voice.joinVoiceChannel);
const mockedEntersState = vi.mocked(voice.entersState) as unknown as ReturnType<
  typeof vi.fn<(connection: VoiceConnection, status: unknown, timeoutMs: number) => Promise<void>>
>;

beforeEach(() => {
  mockedJoinVoiceChannel.mockReset();
  mockedEntersState.mockReset();
  // connectForPlayback calls `delay(1_500)` between retries plus a 1s post-join
  // pause inside joinAndPrepare. Skip those with fake timers so a retry
  // sequence finishes inside the default 5s test budget.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Runs the async callback while draining any pending timer-based delays.
 * `service.ts` uses `setTimeout` for its retry back-off and post-join pause;
 * we advance fake timers until the microtask queue is empty so the real
 * control flow is preserved without paying wall-clock time.
 */
async function runWithFakeTimers<T>(callback: () => Promise<T>): Promise<T> {
  const result = callback();
  // Repeatedly flush pending timers until the callback settles. Each iteration
  // moves the clock forward by a generous slice to absorb the longest delay in
  // the production code (1_500ms).
  for (let depth = 0; depth < 20; depth += 1) {
    await vi.advanceTimersByTimeAsync(2_000);
    // Allow queued microtasks (Promise.resolve chains from the mock helpers)
    // to settle before checking whether the outer promise has resolved.
    await Promise.resolve();
  }
  return result;
}

describe("connectForPlayback stage reconnect", () => {
  it("returns the initial connection without retrying on a non-stage channel", async () => {
    const connection = buildVoiceConnection();
    mockedJoinVoiceChannel.mockReturnValue(connection);

    const nonStageChannel = {
      ...buildStageChannel(),
      type: ChannelType.GuildVoice as unknown as VoiceBasedChannel["type"],
    } as VoiceBasedChannel;

    const result = await runWithFakeTimers(() =>
      connectForPlayback(nonStageChannel, buildClient(), 5_000),
    );

    expect(result).toBe(connection);
    expect(mockedJoinVoiceChannel).toHaveBeenCalledTimes(1);
    expect(connection.destroy as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("reconnects and returns the new connection on a successful retry", async () => {
    const initialConnection = buildVoiceConnection();
    const reconnectedConnection = buildVoiceConnection();
    mockedJoinVoiceChannel
      .mockReturnValueOnce(initialConnection)
      .mockReturnValueOnce(reconnectedConnection);
    mockedEntersState.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);

    const result = await runWithFakeTimers(() =>
      connectForPlayback(buildStageChannel(), buildClient(), 5_000),
    );

    expect(result).toBe(reconnectedConnection);
    expect(mockedJoinVoiceChannel).toHaveBeenCalledTimes(2);
    // The previous attempt's connection must be torn down before retrying,
    // but the successful final connection is returned alive to the caller.
    expect(initialConnection.destroy as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(reconnectedConnection.destroy as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("exhausts attempts and throws when joinAndPrepare keeps failing", async () => {
    // The initial joinAndPrepare succeeds (so we reach the retry loop), then
    // each of the MAX_STAGE_RECONNECT_ATTEMPTS retries times out.
    const connections = [
      buildVoiceConnection(),
      buildVoiceConnection(),
      buildVoiceConnection(),
      buildVoiceConnection(),
    ];
    mockedJoinVoiceChannel.mockImplementation(() => connections.shift() as VoiceConnection);
    mockedEntersState
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("voice timeout"))
      .mockRejectedValueOnce(new Error("voice timeout"))
      .mockRejectedValueOnce(new Error("voice timeout"));

    const expectation = runWithFakeTimers(() =>
      expect(connectForPlayback(buildStageChannel(), buildClient(), 1_000)).rejects.toThrow(
        /Failed to connect to stage channel after 3 attempts/,
      ),
    );

    await expectation;
    expect(mockedJoinVoiceChannel).toHaveBeenCalledTimes(4);
  });

  it("does not throw when joinAndPrepare destroys its own connection on failure", async () => {
    // Simulate the @discordjs/voice behaviour where joinAndPrepare calls
    // connection.destroy() internally on timeout. The next loop iteration's
    // safeDestroy must swallow the "already destroyed" error instead of
    // letting it escape and abort the reconnect loop.
    const initialConnection = buildVoiceConnection();
    const failedConnection = buildVoiceConnection();
    const recoveredConnection = buildVoiceConnection();
    (failedConnection.destroy as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("Cannot destroy VoiceConnection - it has already been destroyed");
    });

    mockedJoinVoiceChannel
      .mockReturnValueOnce(initialConnection)
      .mockReturnValueOnce(failedConnection)
      .mockReturnValueOnce(recoveredConnection);
    mockedEntersState
      .mockResolvedValueOnce(undefined) // initial join succeeds
      .mockRejectedValueOnce(new Error("voice timeout")) // first retry fails
      .mockResolvedValueOnce(undefined); // second retry succeeds

    const result = await runWithFakeTimers(() =>
      connectForPlayback(buildStageChannel(), buildClient(), 5_000),
    );

    expect(result).toBe(recoveredConnection);
    // failedConnection.destroy() was called once by joinAndPrepare; the loop
    // must NOT call it again or it would throw and tear the loop down.
    expect(failedConnection.destroy as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(mockedJoinVoiceChannel).toHaveBeenCalledTimes(3);
  });
});
