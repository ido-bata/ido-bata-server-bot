import { describe, expect, it } from "vitest";

import { formatJoinAudit, formatLeaveAudit } from "../src/features/member-audit/template.js";

describe("member audit template", () => {
  it("renders the join message with the joined timestamp and account-created relative token", () => {
    const joinedAt = new Date("2026-09-13T12:00:00Z");
    const accountCreatedAt = new Date("2026-08-01T00:00:00Z");
    const joinedSeconds = Math.floor(joinedAt.getTime() / 1000).toString();
    const createdSeconds = Math.floor(accountCreatedAt.getTime() / 1000).toString();

    const message = formatJoinAudit({
      memberName: "alice",
      joinedAt,
      accountCreatedAt,
    });

    expect(message).toBe(
      `<t:${joinedSeconds}:F> 🟢 alice joined (account created: <t:${createdSeconds}:R>)`,
    );
  });

  it("omits the account-created clause when the user object is unavailable", () => {
    const joinedAt = new Date("2026-09-13T12:00:00Z");
    const joinedSeconds = Math.floor(joinedAt.getTime() / 1000).toString();

    const message = formatJoinAudit({
      memberName: "bob",
      joinedAt,
      accountCreatedAt: null,
    });

    expect(message).toBe(`<t:${joinedSeconds}:F> 🟢 bob joined`);
  });

  it("renders the leave message with the left timestamp", () => {
    const leftAt = new Date("2026-09-13T13:30:00Z");
    const leftSeconds = Math.floor(leftAt.getTime() / 1000).toString();

    const message = formatLeaveAudit({ memberName: "carol", leftAt });

    expect(message).toBe(`<t:${leftSeconds}:F> 🔴 carol left`);
  });
});
