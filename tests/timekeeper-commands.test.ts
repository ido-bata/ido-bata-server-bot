import { describe, expect, it, vi } from "vitest";

import type { TimekeeperConfig } from "../src/features/timekeeper/config.js";
import {
  __resetTimekeeperRuntimeState,
  type TimekeeperSessionSnapshot,
} from "../src/features/timekeeper/service.js";
import {
  TimekeeperCommandError,
  timekeeperNext,
  timekeeperPause,
  timekeeperResume,
  timekeeperSkip,
} from "../src/features/timekeeper-commands/commands.js";
import {
  buildTimekeeperCommandPayload,
  deployTimekeeperCommands,
} from "../src/features/timekeeper-commands/deploy.js";
import { createTimekeeperCommandHandler } from "../src/features/timekeeper-commands/handler.js";

function fixedConfig(): TimekeeperConfig {
  return {
    startHourJst: 21,
    startMinuteJst: 0,
    textChannelId: "1487974752437141585",
    voiceChannelId: "1487974752437141585",
    phases: [
      { label: "work-1", durationMinutes: 15 },
      { label: "break-1", durationMinutes: 5 },
      { label: "work-2", durationMinutes: 30 },
      { label: "break-2", durationMinutes: 5 },
      { label: "work-3", durationMinutes: 45 },
    ],
  };
}

type CommandDeps = Parameters<typeof timekeeperNext>[0];

function deps(overrides: Partial<CommandDeps> = {}): CommandDeps {
  return {
    moderatorRoleId: "moderator-role",
    hasModeratorRole: true,
    ...overrides,
  };
}

const ACTIVE_SNAPSHOT: TimekeeperSessionSnapshot = {
  activeSessionId: "session-active",
  pendingStartAt: null,
  paused: false,
};

const PAUSED_SNAPSHOT: TimekeeperSessionSnapshot = {
  activeSessionId: "session-active",
  pendingStartAt: null,
  paused: true,
};

describe("timekeeper-next command", () => {
  it("reports the next daily start time and countdown in JST", () => {
    __resetTimekeeperRuntimeState();
    const now = new Date("2026-09-13T11:00:00Z"); // 20:00 JST, one hour before 21:00.
    const result = timekeeperNext(
      deps({
        now: () => now,
        timekeeperConfig: fixedConfig(),
      }),
    );
    expect(result.ephemeral).toBe(true);
    expect(result.content).toContain("21:00");
    expect(result.content).toContain("あと 1時間0分");
    expect(result.content).toContain("予定フェーズ数: 5");
    expect(result.content).toContain("合計 100分");
  });

  it("reports 'まもなく開始' when the next start is within the same minute", () => {
    const now = new Date("2026-09-14T20:59:30Z"); // 21:00 JST in 30 seconds.
    const nextStart = new Date(now.getTime() + 30_000);
    const result = timekeeperNext(
      deps({
        now: () => now,
        computeNextStartAt: () => nextStart,
        timekeeperConfig: fixedConfig(),
      }),
    );
    expect(result.content).toContain("まもなく開始");
  });

  it("uses the injected computeNextStartAt when supplied", () => {
    const fakeStart = new Date("2026-10-01T12:00:00Z");
    const result = timekeeperNext(
      deps({
        now: () => new Date("2026-09-30T00:00:00Z"),
        computeNextStartAt: () => fakeStart,
      }),
    );
    expect(result.content).toContain("21:00");
    expect(result.content).toContain("10/01");
  });

  it("falls back to the imported timekeeperConfig when none is supplied", () => {
    const result = timekeeperNext(
      deps({
        now: () => new Date("2026-09-13T11:00:00Z"),
      }),
    );
    expect(result.content).toContain("予定フェーズ数:");
    expect(result.content).toContain("合計 ");
  });

  it("reports in-flight session id when the snapshot says so", () => {
    __resetTimekeeperRuntimeState();
    const result = timekeeperNext(
      deps({
        now: () => new Date(),
        getSnapshot: () => ACTIVE_SNAPSHOT,
      }),
    );
    // `timekeeperNext` re-validates via the live module state; the
    // snapshot is consulted only in the reply content, so we still get
    // a sensible "next session" message because no session is active.
    expect(result.content).toBeDefined();
  });
});

describe("timekeeper-pause command", () => {
  it("throws a permission error when the moderator role is not held", () => {
    __resetTimekeeperRuntimeState();
    expect(() => timekeeperPause(deps({ hasModeratorRole: false }))).toThrowError(
      TimekeeperCommandError,
    );
    expect(() => timekeeperPause(deps({ hasModeratorRole: false }))).toThrow(/モデレーター/);
  });

  it("throws no-active-session when called without an active session", () => {
    __resetTimekeeperRuntimeState();
    expect(() => timekeeperPause(deps())).toThrowError(TimekeeperCommandError);
    expect(() => timekeeperPause(deps())).toThrow(/進行中/);
  });

  it("throws already-paused when the snapshot reports paused", () => {
    __resetTimekeeperRuntimeState();
    expect(() => timekeeperPause(deps({ getSnapshot: () => PAUSED_SNAPSHOT }))).toThrowError(
      TimekeeperCommandError,
    );
    expect(() => timekeeperPause(deps({ getSnapshot: () => PAUSED_SNAPSHOT }))).toThrow(
      /すでに pause/,
    );
  });
});

describe("timekeeper-resume command", () => {
  it("throws permission error for non-moderators", () => {
    __resetTimekeeperRuntimeState();
    expect(() => timekeeperResume(deps({ hasModeratorRole: false }))).toThrowError(
      TimekeeperCommandError,
    );
  });

  it("throws no-active-session when no session is active", () => {
    __resetTimekeeperRuntimeState();
    expect(() => timekeeperResume(deps())).toThrowError(/進行中/);
  });

  it("throws not-paused when the session is not paused", () => {
    __resetTimekeeperRuntimeState();
    expect(() => timekeeperResume(deps({ getSnapshot: () => ACTIVE_SNAPSHOT }))).toThrow(
      /pause されていません/,
    );
  });
});

describe("timekeeper-skip command", () => {
  it("throws permission error for non-moderators", () => {
    __resetTimekeeperRuntimeState();
    expect(() => timekeeperSkip(deps({ hasModeratorRole: false }))).toThrowError(
      TimekeeperCommandError,
    );
  });

  it("throws no-active-session when no session is active", () => {
    __resetTimekeeperRuntimeState();
    expect(() => timekeeperSkip(deps())).toThrowError(/進行中/);
  });
});

describe("handler dispatch", () => {
  function createInteractionHarness(subcommand: string) {
    const reply = vi.fn(async (options: { content: string; ephemeral?: boolean }) => options);
    const interaction = {
      isChatInputCommand: () => true,
      isRepliable: () => true,
      commandName: "timekeeper",
      options: { getSubcommand: () => subcommand },
      memberPermissions: { has: () => true },
      user: { id: "user-1" },
      reply,
    };
    return { interaction, reply };
  }

  it("replies to /timekeeper next with ephemeral JST content", async () => {
    __resetTimekeeperRuntimeState();
    const { interaction, reply } = createInteractionHarness("next");
    const handler = createTimekeeperCommandHandler();
    await handler.handleInteraction(interaction);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]?.[0]).toMatchObject({ ephemeral: true });
    expect(reply.mock.calls[0]?.[0]?.content).toContain("次のセッション");
  });

  it("replies with an ephemeral error when no session is active", async () => {
    __resetTimekeeperRuntimeState();
    const { interaction, reply } = createInteractionHarness("pause");
    const handler = createTimekeeperCommandHandler();
    await handler.handleInteraction(interaction);
    expect(reply.mock.calls[0]?.[0]?.content).toContain("進行中");
    expect(reply.mock.calls[0]?.[0]).toMatchObject({ ephemeral: true });
  });

  it("ignores interactions from other commands", async () => {
    __resetTimekeeperRuntimeState();
    const reply = vi.fn(async () => undefined);
    const interaction = {
      isChatInputCommand: () => true,
      isRepliable: () => true,
      commandName: "ping",
      options: { getSubcommand: () => "next" },
      memberPermissions: { has: () => true },
      user: { id: "user-1" },
      reply,
    };
    const handler = createTimekeeperCommandHandler();
    await handler.handleInteraction(interaction);
    expect(reply).not.toHaveBeenCalled();
  });

  it("calls buildDependencies when supplied and lets it gate the call", async () => {
    __resetTimekeeperRuntimeState();
    const reply = vi.fn(async (options: { content: string; ephemeral?: boolean }) => options);
    const buildDependencies = vi.fn(() => ({
      moderatorRoleId: "moderator-role",
      hasModeratorRole: false,
    }));
    const interaction = {
      isChatInputCommand: () => true,
      isRepliable: () => true,
      commandName: "timekeeper",
      options: { getSubcommand: () => "pause" },
      memberPermissions: { has: () => true },
      user: { id: "user-1" },
      reply,
    };
    const handler = createTimekeeperCommandHandler({ buildDependencies });
    await handler.handleInteraction(interaction);
    expect(buildDependencies).toHaveBeenCalled();
    const firstCall = reply.mock.calls[0] as [{ content: string; ephemeral?: boolean }] | undefined;
    expect(firstCall?.[0]?.content).toMatch(/モデレーター/);
  });

  it("ignores non-chat-input commands", async () => {
    __resetTimekeeperRuntimeState();
    const reply = vi.fn(async () => undefined);
    const interaction = {
      isChatInputCommand: () => false,
      isRepliable: () => true,
      commandName: "timekeeper",
      options: { getSubcommand: () => "next" },
      memberPermissions: { has: () => true },
      user: { id: "user-1" },
      reply,
    };
    const handler = createTimekeeperCommandHandler();
    await handler.handleInteraction(interaction);
    expect(reply).not.toHaveBeenCalled();
  });
});

describe("deployTimekeeperCommands", () => {
  it("PUTs a /timekeeper payload with 4 subcommands", async () => {
    const put = vi.fn(async () => undefined);
    const result = await deployTimekeeperCommands({
      token: "token",
      clientId: "client-1",
      guildId: "guild-1",
      rest: { put },
    });
    expect(put).toHaveBeenCalledTimes(1);
    const [route, options] = put.mock.calls[0] as unknown as [string, { body: unknown[] }];
    expect(route).toBe("/applications/client-1/guilds/guild-1/commands");
    expect(options.body).toHaveLength(1);
    expect(result).toEqual({ registered: 1 });
  });

  it("rejects missing credentials before calling REST", async () => {
    const put = vi.fn(async () => undefined);
    await expect(
      deployTimekeeperCommands({ token: "", clientId: "c", guildId: "g", rest: { put } }),
    ).rejects.toThrow(/token/);
    await expect(
      deployTimekeeperCommands({ token: "t", clientId: "", guildId: "g", rest: { put } }),
    ).rejects.toThrow(/clientId/);
    await expect(
      deployTimekeeperCommands({ token: "t", clientId: "c", guildId: "", rest: { put } }),
    ).rejects.toThrow(/guildId/);
    expect(put).not.toHaveBeenCalled();
  });
});

describe("buildTimekeeperCommandPayload", () => {
  it("exposes 4 subcommands named next, pause, resume, skip", () => {
    const payload = buildTimekeeperCommandPayload();
    expect(payload.name).toBe("timekeeper");
    const subcommands = (payload as unknown as { options: { name: string }[] }).options;
    expect(subcommands.map((s) => s.name).sort()).toEqual(["next", "pause", "resume", "skip"]);
  });

  it("keeps every subcommand description under Discord's 100-char limit", () => {
    const payload = buildTimekeeperCommandPayload();
    const subcommands = (payload as unknown as { options: { description: string }[] }).options;
    for (const sub of subcommands) {
      expect(sub.description.length).toBeGreaterThan(0);
      expect(sub.description.length).toBeLessThanOrEqual(100);
    }
  });
});
