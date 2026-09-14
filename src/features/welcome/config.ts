export type WelcomeConfig = {
  welcomeChannelId: string;
  onboardingChannelId: string | null;
};

// Replace these placeholder values with your actual Discord IDs.
export const welcomeConfig: WelcomeConfig = {
  welcomeChannelId: "REPLACE_WITH_WELCOME_CHANNEL_ID",
  onboardingChannelId: null,
};

export function isWelcomeConfigured(config: WelcomeConfig): boolean {
  return (
    !config.welcomeChannelId.includes("REPLACE_WITH") && !config.welcomeChannelId.includes("HERE")
  );
}
