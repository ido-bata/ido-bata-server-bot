import { describe, expect, it } from "vitest";

import { isWelcomeConfigured, type WelcomeConfig } from "../src/features/welcome/config.js";
import { buildWelcomeMessage } from "../src/features/welcome/messages.js";

describe("welcome config", () => {
  it("treats placeholder channel ids as unconfigured", () => {
    const placeholder: WelcomeConfig = {
      welcomeChannelId: "REPLACE_WITH_WELCOME_CHANNEL_ID",
      onboardingChannelId: null,
    };
    expect(isWelcomeConfigured(placeholder)).toBe(false);
  });

  it("treats configured channel ids as configured", () => {
    const configured: WelcomeConfig = {
      welcomeChannelId: "1234567890",
      onboardingChannelId: "9876543210",
    };
    expect(isWelcomeConfigured(configured)).toBe(true);
  });
});

describe("welcome messages", () => {
  it("includes the member mention and onboarding reference when configured", () => {
    const message = buildWelcomeMessage(
      { id: "user-1", displayName: "Tester" },
      { welcomeChannelId: "1234", onboardingChannelId: "5678" },
    );

    expect(message).toContain("<@user-1>");
    expect(message).toContain("<#5678>");
    expect(message).not.toContain("REPLACE_WITH");
  });

  it("omits the onboarding reference when no onboarding channel is set", () => {
    const message = buildWelcomeMessage(
      { id: "user-2", displayName: "Tester" },
      { welcomeChannelId: "1234", onboardingChannelId: null },
    );

    expect(message).toContain("<@user-2>");
    expect(message).not.toMatch(/<#\d+>/);
  });
});
