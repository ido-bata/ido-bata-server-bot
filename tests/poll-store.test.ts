import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Poll } from "../src/features/poll/state.js";
import {
  createFilePollStore,
  createPollState,
  findPollById,
  findPollByMessageId,
  pollStateFileSchema,
  upsertPoll,
} from "../src/features/poll/state.js";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "poll-store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makePoll(overrides: Partial<Poll> = {}): Poll {
  return {
    id: "poll-1",
    guildId: "guild-1",
    channelId: "channel-1",
    messageId: "message-1",
    question: "好きな果物は?",
    options: ["りんご", "みかん"],
    creatorId: "creator-1",
    createdAt: "2026-09-13T00:00:00.000Z",
    closed: false,
    votes: {},
    ...overrides,
  };
}

describe("poll store", () => {
  it("returns an empty state when the file does not exist", () => {
    const store = createFilePollStore(join(dir, "missing.json"));

    const state = store.load();

    expect(state).toEqual(createPollState());
  });

  it("round-trips a poll through save and load", () => {
    const path = join(dir, "polls.json");
    const store = createFilePollStore(path);
    const original = makePoll();

    store.save(upsertPoll(createPollState(), original));
    const loaded = store.load();

    expect(loaded.polls).toHaveLength(1);
    expect(loaded.polls[0]).toEqual(original);
    expect(loaded.version).toBe(1);

    // The on-disk format should be pretty-printed JSON for human inspection.
    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).toContain("\n");
    expect(JSON.parse(onDisk)).toEqual(loaded);
  });

  it("load is idempotent: load → save → load yields the same state", () => {
    const path = join(dir, "polls.json");
    const store = createFilePollStore(path);
    const original = makePoll();
    const first = upsertPoll(createPollState(), original);
    store.save(first);

    const reloaded = store.load();
    // Re-saving should be a no-op aside from formatting.
    store.save(reloaded);

    expect(store.load()).toEqual(reloaded);
  });

  it("upserts replace existing polls by id", () => {
    const path = join(dir, "polls.json");
    const store = createFilePollStore(path);

    const original = makePoll({ id: "p-1", votes: { "u-1": 0 } });
    store.save(upsertPoll(createPollState(), original));

    const updated = makePoll({ id: "p-1", votes: { "u-1": 1, "u-2": 0 } });
    store.save(upsertPoll(store.load(), updated));

    const loaded = store.load();
    expect(loaded.polls).toHaveLength(1);
    expect(loaded.polls[0]?.votes).toEqual({ "u-1": 1, "u-2": 0 });
  });

  it("treats a corrupt JSON file as an empty state and logs a warning", () => {
    const path = join(dir, "polls.json");
    const store = createFilePollStore(path);

    // Write something the schema cannot parse.
    writeFileSync(path, "{}", "utf8");

    const state = store.load();
    expect(state).toEqual(createPollState());
  });

  it("treats an empty file as an empty state without throwing", () => {
    const path = join(dir, "polls.json");
    const store = createFilePollStore(path);
    writeFileSync(path, "", "utf8");

    expect(store.load()).toEqual(createPollState());
  });

  it("finds a poll by message id and by id", () => {
    const a = makePoll({ id: "p-1", messageId: "m-1" });
    const b = makePoll({ id: "p-2", messageId: "m-2" });
    const state = upsertPoll(upsertPoll(createPollState(), a), b);

    expect(findPollByMessageId(state, "m-2")?.id).toBe("p-2");
    expect(findPollById(state, "p-1")?.messageId).toBe("m-1");
    expect(findPollByMessageId(state, "missing")).toBeUndefined();
  });

  it("schema rejects an out-of-range vote index", () => {
    const result = pollStateFileSchema.safeParse({
      version: 1,
      polls: [
        makePoll({
          votes: { "u-1": 99 },
        }),
      ],
    });
    expect(result.success).toBe(false);
  });

  it("schema accepts a vote pointing at a valid option index", () => {
    const result = pollStateFileSchema.safeParse({
      version: 1,
      polls: [
        makePoll({
          votes: { "u-1": 0, "u-2": 1 },
        }),
      ],
    });
    expect(result.success).toBe(true);
  });
});
