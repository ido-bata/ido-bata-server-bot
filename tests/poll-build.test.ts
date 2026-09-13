import { describe, expect, it } from "vitest";

import {
  buildPollButtonCustomId,
  buildPollClearCustomId,
  buildPollEmbed,
  buildPollMessageComponents,
  parsePollButtonCustomId,
} from "../src/features/poll/build.js";
import type { Poll } from "../src/features/poll/state.js";

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

describe("poll build", () => {
  it("round-trips vote and clear custom ids through the parser", () => {
    const voteId = buildPollButtonCustomId("poll-1", 3);
    expect(voteId).toBe("poll:poll-1:vote:3");
    expect(parsePollButtonCustomId(voteId)).toEqual({
      pollId: "poll-1",
      kind: "vote",
      optionIndex: 3,
    });

    const clearId = buildPollClearCustomId("poll-1");
    expect(clearId).toBe("poll:poll-1:clear");
    expect(parsePollButtonCustomId(clearId)).toEqual({
      pollId: "poll-1",
      kind: "clear",
    });
  });

  it("returns null for unrelated custom ids", () => {
    expect(parsePollButtonCustomId("reaction-role:🔥")).toBeNull();
    expect(parsePollButtonCustomId("poll:")).toBeNull();
    expect(parsePollButtonCustomId("poll::vote:0")).toBeNull();
    expect(parsePollButtonCustomId("poll:poll-1:vote:not-a-number")).toBeNull();
  });

  it("builds two rows of buttons for 10 options plus a clear row", () => {
    const poll = makePoll({
      options: Array.from({ length: 10 }, (_, index) => `option-${index + 1}`),
    });

    const components = buildPollMessageComponents(poll);

    expect(components.rows).toHaveLength(3); // 2 vote rows + 1 clear row
    expect(components.rows[0]?.components).toHaveLength(5);
    expect(components.rows[1]?.components).toHaveLength(5);
    expect(components.rows[2]?.components).toHaveLength(1);
    expect(components.rows[2]?.components[0]?.custom_id).toBe(buildPollClearCustomId("poll-1"));
  });

  it("truncates labels longer than 80 characters", () => {
    const long = "x".repeat(120);
    const poll = makePoll({ options: [long, "short"] });

    const components = buildPollMessageComponents(poll);
    const firstLabel = components.rows[0]?.components[0]?.label ?? "";

    expect(firstLabel.length).toBeLessThanOrEqual(80);
    expect(firstLabel.endsWith("…")).toBe(true);
  });

  it("renders a closed poll with closed status in the embed", () => {
    const closed = makePoll({
      closed: true,
      closedAt: "2026-09-13T12:00:00.000Z",
    });

    const embed = buildPollEmbed(closed);

    expect(embed.title).toContain("closed");
    expect(embed.description).toContain("終了");
  });

  it("renders the question and option lines in the embed", () => {
    const poll = makePoll();

    const embed = buildPollEmbed(poll);

    expect(embed.description).toContain("好きな果物は?");
    expect(embed.description).toContain("りんご");
    expect(embed.description).toContain("みかん");
  });

  it("renders 0% and an empty bar for options with no votes", () => {
    const poll = makePoll();

    const embed = buildPollEmbed(poll);

    expect(embed.description).toMatch(/0票/);
    expect(embed.description).toContain("░░░░░░░░░░");
  });
});
