import { describe, expect, it } from "vitest";

import {
  type PersistedReminder,
} from "../src/features/reminder/store.js";
import {
  getNextFireTime,
  pickNextFire,
  pickOverdueReminders,
} from "../src/features/reminder/scheduler.js";

function reminder(overrides: Partial<PersistedReminder>): PersistedReminder {
  return {
    id: "r",
    userId: "u",
    message: "msg",
    fireAt: new Date("2030-01-01T00:00:00+09:00").toISOString(),
    createdAt: new Date("2030-01-01T00:00:00+09:00").toISOString(),
    ...overrides,
  };
}

describe("reminder scheduler", () => {
  it("returns null when the reminder is in the past", () => {
    const now = new Date("2030-01-02T00:00:00+09:00");
    const result = getNextFireTime(reminder({ fireAt: new Date("2030-01-01T00:00:00+09:00").toISOString() }), now);
    expect(result).toBeNull();
  });

  it("returns the fire date when it is in the future", () => {
    const fire = new Date("2030-01-01T00:00:00+09:00");
    const now = new Date("2029-12-31T00:00:00+09:00");
    const result = getNextFireTime(reminder({ fireAt: fire.toISOString() }), now);
    expect(result?.toISOString()).toBe(fire.toISOString());
  });

  it("picks overdue reminders in chronological order", () => {
    const now = new Date("2030-01-02T00:00:00+09:00");
    const entries = [
      reminder({ id: "late", fireAt: new Date("2030-01-01T00:00:00+09:00").toISOString() }),
      reminder({ id: "earlier", fireAt: new Date("2029-12-31T00:00:00+09:00").toISOString() }),
      reminder({ id: "future", fireAt: new Date("2031-01-01T00:00:00+09:00").toISOString() }),
    ];
    const result = pickOverdueReminders(entries, now);
    expect(result.map((f) => f.reminder.id)).toEqual(["earlier", "late"]);
  });

  it("picks the next future fire", () => {
    const now = new Date("2030-01-01T00:00:00+09:00");
    const entries = [
      reminder({ id: "future-late", fireAt: new Date("2030-01-05T00:00:00+09:00").toISOString() }),
      reminder({ id: "future-soon", fireAt: new Date("2030-01-02T00:00:00+09:00").toISOString() }),
      reminder({ id: "past", fireAt: new Date("2029-01-01T00:00:00+09:00").toISOString() }),
    ];
    const next = pickNextFire(entries, now);
    expect(next?.reminder.id).toBe("future-soon");
  });

  it("returns null when no reminders are queued", () => {
    expect(pickNextFire([], new Date())).toBeNull();
  });
});
