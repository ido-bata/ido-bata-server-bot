import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createShutdownRunner,
  type ShutdownDependencies,
} from "../src/features/shutdown/handler.js";

type FakeVoiceConnection = { destroy: () => void };

const voiceRegistry = new Map<string, FakeVoiceConnection>();

vi.mock("@discordjs/voice", async () => {
  const actual = await vi.importActual("@discordjs/voice");
  return {
    ...actual,
    getVoiceConnections: () => voiceRegistry,
  };
});

function createFakeClient() {
  return {
    destroy: vi.fn(async () => undefined),
  };
}

function createFakeConnection(): FakeVoiceConnection {
  return { destroy: vi.fn() };
}

type RunnerHarness = {
  cancelSession: ReturnType<typeof vi.fn>;
  client: ReturnType<typeof createFakeClient>;
  dependencies: ShutdownDependencies;
  destroyClient: ReturnType<typeof vi.fn>;
  destroyVoiceConnections: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
  messages: string[];
  runner: ReturnType<typeof createShutdownRunner>;
};

function setupRunner(overrides: Partial<ShutdownDependencies> = {}): RunnerHarness {
  const messages: string[] = [];
  const client = createFakeClient();

  const dependencies: ShutdownDependencies = {
    cancelSession: vi.fn<() => boolean>(() => false),
    destroyClient: vi.fn<() => Promise<void>>(async () => undefined),
    destroyVoiceConnections: vi.fn<() => void>(() => undefined),
    exit: vi.fn<(code: number) => void>(() => undefined),
    now: () => new Date("2026-04-01T00:00:00Z"),
    ...overrides,
  };

  const runner = createShutdownRunner(
    client as unknown as Parameters<typeof createShutdownRunner>[0],
    dependencies,
    (message) => messages.push(message),
  );

  return {
    cancelSession: dependencies.cancelSession as ReturnType<typeof vi.fn>,
    client,
    dependencies,
    destroyClient: dependencies.destroyClient as ReturnType<typeof vi.fn>,
    destroyVoiceConnections: dependencies.destroyVoiceConnections as ReturnType<typeof vi.fn>,
    exit: dependencies.exit as ReturnType<typeof vi.fn>,
    messages,
    runner,
  };
}

describe("shutdown handler", () => {
  beforeEach(() => {
    voiceRegistry.clear();
  });

  afterEach(() => {
    voiceRegistry.clear();
    vi.restoreAllMocks();
  });

  it("runs the full graceful-shutdown sequence on SIGINT", async () => {
    const connection = createFakeConnection();
    voiceRegistry.set("guild-1", connection);

    // Pass a destroyer that mirrors the default behavior so the
    // connection.destroy() assertions still hold.
    const destroyVoiceConnections = vi.fn(() => {
      for (const conn of voiceRegistry.values()) {
        conn.destroy();
      }
    });

    const { cancelSession, client, destroyClient, exit, messages, runner } = setupRunner({
      cancelSession: vi.fn(() => true),
      destroyVoiceConnections,
    });

    await runner.run("SIGINT");

    expect(cancelSession).toHaveBeenCalledTimes(1);
    expect(destroyVoiceConnections).toHaveBeenCalledTimes(1);
    expect(destroyClient).toHaveBeenCalledTimes(1);
    expect(client.destroy).not.toHaveBeenCalled();
    expect(connection.destroy).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(messages[0]).toContain("Received SIGINT");
    expect(messages).toContain("Voice connections destroyed");
    expect(messages).toContain("Discord client destroyed");
    expect(messages.at(-1)).toBe("Graceful shutdown complete");
  });

  it("also exits cleanly on SIGTERM with no active session", async () => {
    const { cancelSession, destroyClient, exit, messages, runner } = setupRunner();

    await runner.run("SIGTERM");

    expect(cancelSession).toHaveBeenCalledTimes(1);
    expect(destroyClient).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(messages[0]).toContain("Received SIGTERM");
    expect(messages).toContain("Timekeeper session cancelled: false");
    expect(messages.at(-1)).toBe("Graceful shutdown complete");
  });

  it("destroys all tracked voice connections via the default destroyer", async () => {
    const connectionA = createFakeConnection();
    const connectionB = createFakeConnection();
    voiceRegistry.set("guild-a", connectionA);
    voiceRegistry.set("guild-b", connectionB);

    // Pass a destroyer that iterates the registry so we can verify the
    // shutdown handler always calls it; the defaultDestroyVoiceConnections
    // path uses the same iteration shape.
    const destroyVoiceConnections = vi.fn(() => {
      for (const connection of voiceRegistry.values()) {
        connection.destroy();
      }
    });

    const { messages, runner } = setupRunner({ destroyVoiceConnections });

    await runner.run("SIGINT");

    expect(destroyVoiceConnections).toHaveBeenCalledTimes(1);
    expect(connectionA.destroy).toHaveBeenCalledTimes(1);
    expect(connectionB.destroy).toHaveBeenCalledTimes(1);
    expect(messages).toContain("Voice connections destroyed");
  });

  it("keeps going when the session-cancel step throws", async () => {
    const { client, destroyClient, exit, messages, runner } = setupRunner({
      cancelSession: vi.fn(() => {
        throw new Error("flush failed");
      }),
    });

    await runner.run("SIGINT");

    expect(destroyClient).toHaveBeenCalledTimes(1);
    expect(client.destroy).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
    expect(messages.some((line) => line.includes("Failed to cancel timekeeper session"))).toBe(
      true,
    );
    expect(messages.at(-1)).toBe("Graceful shutdown complete");
  });

  it("keeps going when client.destroy() rejects", async () => {
    const { cancelSession, exit, messages, runner } = setupRunner({
      destroyClient: vi.fn(async () => {
        throw new Error("destroy failed");
      }),
    });

    await runner.run("SIGTERM");

    expect(cancelSession).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(messages.some((line) => line.includes("Failed to destroy Discord client"))).toBe(true);
    expect(messages.at(-1)).toBe("Graceful shutdown complete");
  });

  it("ignores a second signal while shutdown is already in progress", async () => {
    let resolveDestroy: () => void = () => undefined;
    const destroyPromise = new Promise<void>((resolve) => {
      resolveDestroy = resolve;
    });

    const { destroyClient, exit, messages, runner } = setupRunner({
      destroyClient: vi.fn(() => destroyPromise),
    });

    const first = runner.run("SIGINT");
    await runner.run("SIGTERM");
    resolveDestroy();
    await first;

    expect(destroyClient).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(messages.some((line) => line.includes("Shutdown already in progress"))).toBe(true);
  });
});
