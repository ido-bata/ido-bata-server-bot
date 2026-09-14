import { describe, expect, it, vi } from "vitest";

import { createWelcomeHandler, type WelcomeOutcome } from "../src/features/welcome/handler.js";

const configuredConfig = {
  welcomeChannelId: "1234567890",
  onboardingChannelId: "9876543210",
};

describe("welcome handler", () => {
  it("posts a welcome message to the configured channel", async () => {
    const send = vi.fn<(content: string) => Promise<void>>(async () => undefined);
    const handler = createWelcomeHandler({
      config: configuredConfig,
      fetchTextChannel: async () => ({ send }),
    });

    const outcome = await handler.onMemberJoin({ member: { id: "user-1", displayName: "Tester" } });

    expect(outcome).toBe<WelcomeOutcome>("sent");
    expect(send).toHaveBeenCalledTimes(1);
    const firstCall = send.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [content] = firstCall;
    expect(typeof content).toBe("string");
    expect(content).toContain("<@user-1>");
    expect(content).toContain("<#9876543210>");
  });

  it("ignores the bot's own member join", async () => {
    const send = vi.fn(async () => undefined);
    const fetchTextChannel = vi.fn();
    const handler = createWelcomeHandler({
      config: configuredConfig,
      fetchTextChannel,
      getBotUserId: () => "bot-1",
    });

    const outcome = await handler.onMemberJoin({ member: { id: "bot-1", displayName: "Bot" } });

    expect(outcome).toBe<WelcomeOutcome>("skipped-self");
    expect(send).not.toHaveBeenCalled();
    expect(fetchTextChannel).not.toHaveBeenCalled();
  });

  it("returns missing-config when the welcome channel id is still a placeholder", async () => {
    const send = vi.fn();
    const handler = createWelcomeHandler({
      config: {
        welcomeChannelId: "REPLACE_WITH_WELCOME_CHANNEL_ID",
        onboardingChannelId: null,
      },
      fetchTextChannel: async () => ({ send }),
    });

    const outcome = await handler.onMemberJoin({ member: { id: "user-1", displayName: "Tester" } });

    expect(outcome).toBe<WelcomeOutcome>("missing-config");
    expect(send).not.toHaveBeenCalled();
  });

  it("returns missing-channel when the configured channel cannot be fetched", async () => {
    const handler = createWelcomeHandler({
      config: configuredConfig,
      fetchTextChannel: async () => null,
    });

    const outcome = await handler.onMemberJoin({ member: { id: "user-1", displayName: "Tester" } });

    expect(outcome).toBe<WelcomeOutcome>("missing-channel");
  });
});
