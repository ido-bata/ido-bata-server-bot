import { describe, expect, it, vi } from "vitest";

import { executeRemindCommand } from "../src/features/reminder/command.js";
import type { AddReminderInput, AddReminderResult, ReminderQueue } from "../src/features/reminder/service.js";

type ReplyCall = { content: string; ephemeral?: boolean };

function makeFakeInteraction(input: { duration: string; message: string; userId?: string }) {
  const replies: ReplyCall[] = [];
  const interaction = {
    options: {
      getString: (name: string) => {
        if (name === "duration") return input.duration;
        if (name === "message") return input.message;
        return null;
      },
    },
    user: { id: input.userId ?? "user-1" },
    reply: vi.fn(async (options: ReplyCall) => {
      replies.push(options);
      return replies;
    }),
  };
  return { interaction, replies };
}

function makeFakeQueue(overrides: Partial<Pick<ReminderQueue, "add" | "countForUser">> = {}): Pick<ReminderQueue, "add" | "countForUser"> {
  const adds: AddReminderInput[] = [];
  const stub = {
    add: overrides.add ?? vi.fn((input: AddReminderInput): AddReminderResult => {
      adds.push(input);
      return {
        ok: true,
        reminder: {
          id: "id-1",
          userId: input.userId,
          message: input.message,
          fireAt: input.fireAt.toISOString(),
          createdAt: (input.createdAt ?? new Date()).toISOString(),
        },
      };
    }),
    countForUser: overrides.countForUser ?? vi.fn(() => 0),
  };
  return stub;
}

const NOW = new Date("2030-01-01T00:00:00+09:00");

describe("executeRemindCommand", () => {
  it("replies with an error for invalid durations", async () => {
    const queue = makeFakeQueue();
    const { interaction, replies } = makeFakeInteraction({ duration: "nope", message: "hi" });

    await executeRemindCommand(interaction as never, { queue, now: () => NOW });

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(replies[0]?.ephemeral).toBe(true);
    expect(replies[0]?.content).toMatch(/duration/);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("replies with an error when over the maximum duration", async () => {
    const queue = makeFakeQueue();
    const { interaction, replies } = makeFakeInteraction({ duration: "30d", message: "hi" });

    await executeRemindCommand(interaction as never, { queue, now: () => NOW });

    expect(replies[0]?.content).toMatch(/上限/);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("replies with an error when per-user limit reached", async () => {
    const queue = makeFakeQueue({ countForUser: () => 10 });
    const { interaction, replies } = makeFakeInteraction({ duration: "30m", message: "hi" });

    await executeRemindCommand(interaction as never, { queue, now: () => NOW });

    expect(replies[0]?.content).toMatch(/上限/);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("replies with an error when message is empty", async () => {
    const queue = makeFakeQueue();
    const { interaction, replies } = makeFakeInteraction({ duration: "30m", message: "   " });

    await executeRemindCommand(interaction as never, { queue, now: () => NOW });

    expect(replies[0]?.content).toMatch(/message/);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("registers a future reminder and replies with a confirmation", async () => {
    const queue = makeFakeQueue();
    const { interaction, replies } = makeFakeInteraction({
      duration: "30m",
      message: "check oven",
    });

    await executeRemindCommand(interaction as never, { queue, now: () => NOW });

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(replies[0]?.ephemeral).toBe(true);
    expect(replies[0]?.content).toContain("登録しました");
    expect(replies[0]?.content).toContain("check oven");
  });

  it("surfaces persistence errors from the queue", async () => {
    const queue = makeFakeQueue({
      add: vi.fn(() => ({ ok: false, error: "queue broken" }) as AddReminderResult),
    });
    const { interaction, replies } = makeFakeInteraction({ duration: "30m", message: "hi" });

    await executeRemindCommand(interaction as never, { queue, now: () => NOW });

    expect(replies[0]?.content).toMatch(/queue broken/);
  });
});
