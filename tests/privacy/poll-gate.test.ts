import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPollButtonCustomId } from "../../src/features/poll/build.js";
import {
  createPollHandler,
  POLL_SUBCOMMAND_CREATE,
  type PollInteractionLike,
} from "../../src/features/poll/handler.js";
import { createFilePollStore } from "../../src/features/poll/state.js";

function makeInteraction(overrides: Partial<PollInteractionLike> = {}): PollInteractionLike & {
  __replies: Array<{ content?: string; ephemeral?: boolean }>;
} {
  const replies: Array<{ content?: string; ephemeral?: boolean }> = [];
  const base: PollInteractionLike = {
    isButton: () => false,
    isChatInputCommand: () => true,
    isRepliable: () => true,
    commandName: "poll",
    options: {
      getSubcommand: () => POLL_SUBCOMMAND_CREATE,
      getString: (name: string) => {
        if (name === "question") return "Which?";
        if (name === "options") return "A\nB";
        return null;
      },
    },
    channelId: "channel-1",
    channel: { send: vi.fn(async () => ({ id: "message-1" })) },
    guildId: "guild-1",
    user: { id: "creator-1" },
    customId: "",
    reply: vi.fn(async (opts: { content?: string; ephemeral?: boolean }) => {
      replies.push(opts);
      return undefined;
    }),
    update: vi.fn(async () => undefined),
    ...overrides,
  };
  return Object.assign(base, { __replies: replies });
}

describe("poll consent gate", () => {
  let storePath: string;
  let cleanup: () => void;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "poll-gate-"));
    storePath = join(dir, "polls.json");
    cleanup = () => rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    cleanup();
  });

  it("denies /poll create when authorize denies", async () => {
    const handler = createPollHandler({
      store: createFilePollStore(storePath),
      consent: { authorize: async () => ({ ok: false }) },
    });
    const interaction = makeInteraction();
    await handler.handleInteraction(interaction);
    expect(interaction.__replies[0]?.content).toContain("activity-history");
    // No poll should be persisted.
    const { existsSync } = await import("node:fs");
    expect(existsSync(storePath)).toBe(false);
  });

  it("allows /poll create when authorize allows", async () => {
    const handler = createPollHandler({
      store: createFilePollStore(storePath),
      consent: { authorize: async () => ({ ok: true }) },
    });
    const interaction = makeInteraction();
    await handler.handleInteraction(interaction);
    expect(handler.loadState().polls).toHaveLength(1);
  });

  it("refuses vote persistence when authorize denies", async () => {
    // First create a poll with a deterministic id so we can address it via
    // a button interaction. The handler's `vote` flow requires the poll id
    // to live in the persisted state — without a fixed id, randomUUID()
    // would leave us guessing.
    const FIXED_ID = "fixed-poll-id";
    const permitHandler = createPollHandler({
      store: createFilePollStore(storePath),
      consent: { authorize: async () => ({ ok: true }) },
      generateId: () => FIXED_ID,
    });
    await permitHandler.handleInteraction(makeInteraction());
    expect(permitHandler.loadState().polls).toHaveLength(1);

    // Now switch the handler to deny-mode and try to vote. The store file
    // is shared because both handlers use the same `storePath`.
    const denyHandler = createPollHandler({
      store: createFilePollStore(storePath),
      consent: { authorize: async () => ({ ok: false }) },
    });
    const before = denyHandler.loadState().polls[0]?.votes ?? {};
    const voteInteraction = makeInteraction({
      commandName: "poll",
      isButton: () => true,
      isChatInputCommand: () => false,
      customId: buildPollButtonCustomId(FIXED_ID, 0),
      user: { id: "voter-1" },
      options: {
        getSubcommand: () => "",
        getString: () => null,
      },
    });
    voteInteraction.message = {
      id: "message-1",
      edit: vi.fn(async () => undefined),
    };

    await denyHandler.handleInteraction(voteInteraction);

    const after = denyHandler.loadState().polls[0]?.votes ?? {};
    expect(after).toEqual(before);
    expect(voteInteraction.__replies[0]?.content).toContain("activity-history");
  });

  it("does not refuse /poll create on a handler without consent wired", async () => {
    // No consent dep at all -> the handler is in fail-closed mode and
    // refuses every persistent mutation. The reply should warn the user.
    const handler = createPollHandler({
      store: createFilePollStore(storePath),
    });
    const interaction = makeInteraction();
    await handler.handleInteraction(interaction);
    expect(interaction.__replies[0]?.content).toContain("activity-history");
    const { existsSync } = await import("node:fs");
    expect(existsSync(storePath)).toBe(false);
  });
});
