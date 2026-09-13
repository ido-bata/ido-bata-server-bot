import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPollButtonCustomId,
  buildPollClearCustomId,
  createPollHandler,
  POLL_COMMAND_NAME,
  POLL_SUBCOMMAND_CLOSE,
  POLL_SUBCOMMAND_CREATE,
  type PollHandlerDependencies,
  type PollInteractionLike,
  parseOptionsString,
} from "../src/features/poll/handler.js";
import type { PollStateFile } from "../src/features/poll/state.js";
import { createFilePollStore } from "../src/features/poll/state.js";

type MakeOptions = {
  commandName: string;
  userId?: string;
  channelId?: string;
  guildId?: string;
  messageId?: string;
  customId?: string;
  isButton?: boolean;
  subcommand?: string;
  stringValues?: Record<string, string>;
};

type TrackingInteraction = PollInteractionLike & {
  __getReplied: () => { content?: string; embeds?: unknown[]; components?: unknown[] };
  __getEdited: () => { embeds?: unknown[]; components?: unknown[] };
};

function makeInteraction(options: MakeOptions): TrackingInteraction {
  const subcommand = options.subcommand ?? POLL_SUBCOMMAND_CREATE;
  const stringValues: Record<string, string> = options.stringValues ?? {};
  const replied: { content?: string; embeds?: unknown[]; components?: unknown[] } = {};
  const edited: { embeds?: unknown[]; components?: unknown[] } = {};

  const base: PollInteractionLike = {
    isChatInputCommand: () => !options.isButton,
    isButton: () => options.isButton ?? false,
    isRepliable: () => true,
    commandName: options.commandName,
    options: {
      getSubcommand: () => subcommand,
      getString: (name: string) => stringValues[name] ?? null,
    },
    channelId: options.channelId ?? "channel-1",
    channel: {
      send: vi.fn(async () => ({ id: "message-1" })),
    },
    guildId: options.guildId ?? "guild-1",
    user: { id: options.userId ?? "creator-1" },
    customId: options.customId ?? "",
    message: {
      id: options.messageId ?? "message-1",
      edit: vi.fn(async (opts: { embeds?: unknown[]; components?: unknown[] }) => {
        edited.embeds = opts.embeds;
        edited.components = opts.components;
        return undefined;
      }),
    },
    reply: vi.fn(async (opts: { content?: string; embeds?: unknown[]; ephemeral?: boolean }) => {
      replied.content = opts.content;
      replied.embeds = opts.embeds;
      return undefined;
    }),
    update: vi.fn(async () => undefined),
  };

  return Object.assign(base, {
    __getReplied: () => replied,
    __getEdited: () => edited,
  });
}

let tmpDir = "";
let storePath = "";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "poll-handler-"));
  storePath = join(tmpDir, "polls.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function newHandler(overrides: Partial<PollHandlerDependencies> = {}) {
  return createPollHandler({ store: createFilePollStore(storePath), ...overrides });
}

describe("poll handler", () => {
  it("creates a poll via /poll create and stores it", async () => {
    const handler = newHandler({
      now: () => "2026-09-13T12:00:00.000Z",
      generateId: () => "poll-id-fixed",
    });

    const interaction = makeInteraction({
      commandName: POLL_COMMAND_NAME,
      userId: "creator-1",
      stringValues: {
        question: "好きな果物は?",
        options: "りんご\nみかん\nバナナ",
      },
    });

    await handler.handleInteraction(interaction);

    expect(interaction.channel.send).toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Poll を作成しました。",
      ephemeral: true,
    });

    const state = handler.loadState();
    expect(state.polls).toHaveLength(1);
    expect(state.polls[0]?.id).toBe("poll-id-fixed");
    expect(state.polls[0]?.messageId).toBe("message-1");
    expect(state.polls[0]?.options).toEqual(["りんご", "みかん", "バナナ"]);
  });

  it("rejects invalid options input with a user-facing error", async () => {
    const handler = newHandler();

    const interaction = makeInteraction({
      commandName: POLL_COMMAND_NAME,
      stringValues: {
        question: "好きな果物は?",
        options: "りんご\nりんご", // duplicates
      },
    });

    await handler.handleInteraction(interaction);

    const replied = interaction.__getReplied();
    expect(replied.content).toMatch(/選択肢の形式が不正です/);
    expect(handler.loadState().polls).toHaveLength(0);
  });

  it("rejects too few options", async () => {
    const handler = newHandler();

    const interaction = makeInteraction({
      commandName: POLL_COMMAND_NAME,
      stringValues: {
        question: "好きな果物は?",
        options: "りんご",
      },
    });

    await handler.handleInteraction(interaction);

    const replied = interaction.__getReplied();
    expect(replied.content).toMatch(/選択肢の形式が不正です/);
  });

  it("applies a vote when the user clicks a poll button", async () => {
    const handler = newHandler({
      now: () => "2026-09-13T12:00:00.000Z",
      generateId: () => "poll-id",
    });

    // Seed a poll through the public handler API.
    const createInteraction = makeInteraction({
      commandName: POLL_COMMAND_NAME,
      stringValues: {
        question: "好きな果物は?",
        options: "りんご\nみかん",
      },
    });
    await handler.handleInteraction(createInteraction);

    const buttonInteraction = makeInteraction({
      commandName: "ignored",
      isButton: true,
      userId: "voter-1",
      customId: buildPollButtonCustomId("poll-id", 1),
    });

    await handler.handleInteraction(buttonInteraction);

    const edited = buttonInteraction.__getEdited();
    expect(buttonInteraction.message.edit).toHaveBeenCalled();
    expect(edited.embeds).toBeDefined();
    expect(buttonInteraction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringMatching(/投票を受け付けました.*みかん/),
        ephemeral: true,
      }),
    );

    const state: PollStateFile = handler.loadState();
    const poll = state.polls[0];
    expect(poll?.votes["voter-1"]).toBe(1);
  });

  it("applies vote override (last-write-wins) on re-click", async () => {
    const handler = newHandler({
      generateId: () => "poll-id",
    });

    const createInteraction = makeInteraction({
      commandName: POLL_COMMAND_NAME,
      stringValues: {
        question: "好きな果物は?",
        options: "りんご\nみかん",
      },
    });
    await handler.handleInteraction(createInteraction);

    const firstVote = makeInteraction({
      commandName: "ignored",
      isButton: true,
      userId: "voter-1",
      customId: buildPollButtonCustomId("poll-id", 0),
    });
    await handler.handleInteraction(firstVote);

    const secondVote = makeInteraction({
      commandName: "ignored",
      isButton: true,
      userId: "voter-1",
      customId: buildPollButtonCustomId("poll-id", 1),
    });
    await handler.handleInteraction(secondVote);

    const poll = handler.loadState().polls[0];
    expect(poll?.votes["voter-1"]).toBe(1);
    expect(secondVote.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringMatching(/投票を更新/),
      }),
    );
  });

  it("handles the clear button by removing the user's vote", async () => {
    const handler = newHandler({
      generateId: () => "poll-id",
    });

    const createInteraction = makeInteraction({
      commandName: POLL_COMMAND_NAME,
      stringValues: {
        question: "好きな果物は?",
        options: "りんご\nみかん",
      },
    });
    await handler.handleInteraction(createInteraction);

    const vote = makeInteraction({
      commandName: "ignored",
      isButton: true,
      userId: "voter-1",
      customId: buildPollButtonCustomId("poll-id", 0),
    });
    await handler.handleInteraction(vote);
    expect(handler.loadState().polls[0]?.votes["voter-1"]).toBe(0);

    const clear = makeInteraction({
      commandName: "ignored",
      isButton: true,
      userId: "voter-1",
      customId: buildPollClearCustomId("poll-id"),
    });
    await handler.handleInteraction(clear);

    expect(handler.loadState().polls[0]?.votes["voter-1"]).toBeUndefined();
    expect(clear.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringMatching(/投票を取り消しました/),
      }),
    );
  });

  it("ignores poll buttons for unknown poll ids", async () => {
    const handler = newHandler();

    const buttonInteraction = makeInteraction({
      commandName: "ignored",
      isButton: true,
      customId: buildPollButtonCustomId("missing-poll", 0),
    });

    await handler.handleInteraction(buttonInteraction);

    expect(buttonInteraction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringMatching(/存在しないか/),
        ephemeral: true,
      }),
    );
  });

  it("closes a poll when the creator runs /poll close", async () => {
    const handler = newHandler({
      now: () => "2026-09-13T12:00:00.000Z",
      generateId: () => "poll-id",
    });

    const createInteraction = makeInteraction({
      commandName: POLL_COMMAND_NAME,
      userId: "creator-1",
      stringValues: {
        question: "好きな果物は?",
        options: "りんご\nみかん",
      },
    });
    await handler.handleInteraction(createInteraction);

    const closeInteraction = makeInteraction({
      commandName: POLL_COMMAND_NAME,
      userId: "creator-1",
      subcommand: POLL_SUBCOMMAND_CLOSE,
      stringValues: { message_id: "message-1" },
    });
    await handler.handleInteraction(closeInteraction);

    expect(closeInteraction.message.edit).toHaveBeenCalled();
    const poll = handler.loadState().polls[0];
    expect(poll?.closed).toBe(true);
    expect(poll?.closedAt).toBe("2026-09-13T12:00:00.000Z");
  });

  it("rejects /poll close from a non-creator", async () => {
    const handler = newHandler({
      generateId: () => "poll-id",
    });

    const createInteraction = makeInteraction({
      commandName: POLL_COMMAND_NAME,
      userId: "creator-1",
      stringValues: {
        question: "好きな果物は?",
        options: "りんご\nみかん",
      },
    });
    await handler.handleInteraction(createInteraction);

    const closeInteraction = makeInteraction({
      commandName: POLL_COMMAND_NAME,
      userId: "imposter-1",
      subcommand: POLL_SUBCOMMAND_CLOSE,
      stringValues: { message_id: "message-1" },
    });
    await handler.handleInteraction(closeInteraction);

    expect(handler.loadState().polls[0]?.closed).toBe(false);
    expect(closeInteraction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringMatching(/作成者のみ/),
      }),
    );
  });

  it("ignores non-poll slash commands", async () => {
    const handler = newHandler();

    const interaction = makeInteraction({ commandName: "ping" });
    await handler.handleInteraction(interaction);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(handler.loadState().polls).toHaveLength(0);
  });
});

describe("parseOptionsString", () => {
  it("splits on newlines", () => {
    expect(parseOptionsString("a\nb\nc")).toEqual(["a", "b", "c"]);
  });

  it("splits on pipes as a fallback separator", () => {
    expect(parseOptionsString("a|b|c")).toEqual(["a", "b", "c"]);
  });

  it("trims whitespace and drops empty segments", () => {
    expect(parseOptionsString("  a \n\n  b  \n")).toEqual(["a", "b"]);
  });

  it("treats CRLF as a single separator", () => {
    expect(parseOptionsString("a\r\nb")).toEqual(["a", "b"]);
  });
});
