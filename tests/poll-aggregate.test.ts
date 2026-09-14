import { describe, expect, it } from "vitest";

import { applyVote, buildTallyRows, clearVote, tallyPoll } from "../src/features/poll/aggregate.js";
import type { Poll } from "../src/features/poll/state.js";

function makePoll(overrides: Partial<Poll> = {}): Poll {
  return {
    id: "poll-1",
    guildId: "guild-1",
    channelId: "channel-1",
    messageId: "message-1",
    question: "好きな果物は?",
    options: ["りんご", "みかん", "バナナ"],
    creatorId: "creator-1",
    createdAt: "2026-09-13T00:00:00.000Z",
    closed: false,
    votes: {},
    ...overrides,
  };
}

describe("poll aggregate", () => {
  it("returns zero counts and no leaders when no votes exist", () => {
    const tally = tallyPoll(makePoll());

    expect(tally.totalVotes).toBe(0);
    expect(tally.counts).toEqual([0, 0, 0]);
    expect(tally.leaders).toEqual([]);
  });

  it("counts votes per option", () => {
    const poll = makePoll({
      votes: { "u-1": 0, "u-2": 1, "u-3": 1, "u-4": 2 },
    });

    const tally = tallyPoll(poll);

    expect(tally.totalVotes).toBe(4);
    expect(tally.counts).toEqual([1, 2, 1]);
    expect(tally.leaders).toEqual([1]);
  });

  it("reports multiple leaders when tied", () => {
    const poll = makePoll({
      votes: { "u-1": 0, "u-2": 2 },
    });

    const tally = tallyPoll(poll);

    expect(tally.totalVotes).toBe(2);
    expect(tally.counts).toEqual([1, 0, 1]);
    expect(tally.leaders).toEqual([0, 2]);
  });

  it("ignores votes pointing at stale option indices", () => {
    const poll = makePoll({
      // 99 is out of range after we shrunk the options.
      votes: { "u-1": 99, "u-2": 0 },
    });

    const tally = tallyPoll(poll);

    expect(tally.totalVotes).toBe(1);
    expect(tally.counts).toEqual([1, 0, 0]);
  });

  it("renders rows with percentages rounded to one decimal place", () => {
    const poll = makePoll({
      votes: { "u-1": 0, "u-2": 0, "u-3": 1 },
    });

    const rows = buildTallyRows(poll);

    expect(rows).toEqual([
      { index: 0, label: "りんご", count: 2, percentage: 66.7 },
      { index: 1, label: "みかん", count: 1, percentage: 33.3 },
      { index: 2, label: "バナナ", count: 0, percentage: 0 },
    ]);
  });

  it("applyVote overwrites a previous vote from the same user", () => {
    const poll = makePoll({
      votes: { "u-1": 0, "u-2": 1 },
    });

    const result = applyVote(poll, "u-1", 2);

    expect(result.changed).toBe(true);
    expect(result.previousOption).toBe(0);
    expect(result.next.votes["u-1"]).toBe(2);
    // Untouched votes are preserved.
    expect(result.next.votes["u-2"]).toBe(1);
    // Original poll object is unchanged.
    expect(poll.votes["u-1"]).toBe(0);
  });

  it("applyVote reports no change when the user votes for the first time", () => {
    const poll = makePoll();

    const result = applyVote(poll, "u-1", 0);

    expect(result.changed).toBe(false);
    expect(result.previousOption).toBeNull();
    expect(result.next.votes["u-1"]).toBe(0);
  });

  it("applyVote reports no change when the user re-votes for the same option", () => {
    const poll = makePoll({
      votes: { "u-1": 1 },
    });

    const result = applyVote(poll, "u-1", 1);

    expect(result.changed).toBe(false);
    expect(result.previousOption).toBe(1);
    expect(result.next.votes["u-1"]).toBe(1);
  });

  it("applyVote throws for an out-of-range option index", () => {
    const poll = makePoll();

    expect(() => applyVote(poll, "u-1", 99)).toThrowError(/Invalid option index/);
  });

  it("clearVote removes the user's entry and reports hadVote correctly", () => {
    const poll = makePoll({
      votes: { "u-1": 0, "u-2": 1 },
    });

    const result = clearVote(poll, "u-1");
    expect(result.hadVote).toBe(true);
    expect(result.next.votes["u-1"]).toBeUndefined();
    expect(result.next.votes["u-2"]).toBe(1);

    const noop = clearVote(poll, "u-9");
    expect(noop.hadVote).toBe(false);
    expect(noop.next).toBe(poll);
  });
});
