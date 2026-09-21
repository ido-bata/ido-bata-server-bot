import { afterEach, describe, expect, it } from "vitest";

import {
  __resetTimekeeperPersistenceState,
  attachPersistenceAuthorization,
  buildCheckInCustomId,
  buildCheckInLabel,
  buildFortuneSummary,
  createSessionEngagement,
  getSessionCheckInCount,
  parseCheckInCustomId,
  recordAttendance,
  recordCheckIn,
} from "../src/features/timekeeper/engagement.js";

describe("timekeeper engagement", () => {
  afterEach(() => {
    __resetTimekeeperPersistenceState();
  });

  it("encodes and decodes phase check-in button ids", () => {
    const customId = buildCheckInCustomId("2026-04-01T21:00", 6);

    expect(customId).toBe("timekeeper:check-in:2026-04-01T21:00:6");
    expect(parseCheckInCustomId(customId)).toEqual({
      sessionId: "2026-04-01T21:00",
      order: 6,
    });
    expect(parseCheckInCustomId("timekeeper:other")).toBeNull();
  });

  it("builds a deterministic fortune summary for checked-in users", async () => {
    const detach = attachPersistenceAuthorization(
      { authorize: async () => ({ ok: true }) },
      () => () => undefined,
    );
    try {
      const session = createSessionEngagement("2026-04-01T21:00");
      recordCheckIn(session, "100", 2);
      recordCheckIn(session, "100", 6);
      recordCheckIn(session, "200", 4);
      await recordAttendance(session, "100", "2026-03-30");
      await recordAttendance(session, "100", "2026-03-31");
      await recordAttendance(session, "100", "2026-04-01");
      await recordAttendance(session, "200", "2026-04-01");

      const topics = [
        {
          title: "一般相対性理論",
          url: "https://ja.wikipedia.org/wiki/%E4%B8%80%E8%88%AC%E7%9B%B8%E5%AF%BE%E6%80%A7%E7%90%86%E8%AB%96",
          extract: "unused",
        },
        {
          title: "深海魚",
          url: "https://ja.wikipedia.org/wiki/%E6%B7%B1%E6%B5%B7%E9%AD%9A",
          extract: "unused",
        },
      ];

      await expect(
        buildFortuneSummary(
          session,
          {
            fetchRandomTopic: async () => topics.shift()!,
          },
          () => 0,
        ),
      ).resolves.toEqual([
        [
          "## 今日の締めおみくじ",
          "<@100> 小吉、今日はまだ静かですが静かなものほどよく動いています。 (参加: 2フェーズ / 連続: 3日)",
          "ランダムWikipedia占い: https://ja.wikipedia.org/wiki/%E4%B8%80%E8%88%AC%E7%9B%B8%E5%AF%BE%E6%80%A7%E7%90%86%E8%AB%96",
        ].join("\n"),
        [
          "## 今日の締めおみくじ",
          "<@200> 末吉、まだ何も起きていませんが何も起きていないにしては前向きです。 (参加: 1フェーズ / 連続: 1日)",
          "ランダムWikipedia占い: https://ja.wikipedia.org/wiki/%E6%B7%B1%E6%B5%B7%E9%AD%9A",
        ].join("\n"),
      ]);
    } finally {
      detach();
    }
  });

  it("provides natural button labels and distinct participant counts", () => {
    const session = createSessionEngagement("2026-04-01T21:00");
    recordCheckIn(session, "100", 2);
    recordCheckIn(session, "100", 6);
    recordCheckIn(session, "200", 2);

    expect(buildCheckInLabel("phase-start")).toBe("フェーズを確認");
    expect(buildCheckInLabel("break-start")).toBe("休憩に入る");
    expect(getSessionCheckInCount(session, 2)).toBe(2);
    expect(getSessionCheckInCount(session, 6)).toBe(1);
  });
});
