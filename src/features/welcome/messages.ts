import type { WelcomeConfig } from "./config.js";

export type WelcomeMember = {
  id: string;
  displayName: string;
};

export function buildWelcomeMessage(member: WelcomeMember, config: WelcomeConfig): string {
  const greeting = `<@${member.id}> さん、ido-bata サーバーへようこそ！`;
  const onboardingReference = config.onboardingChannelId
    ? `\nロールのセルフアサインは <#${config.onboardingChannelId}> のリアクションから行えます。`
    : "";

  return `${greeting}\nまずは自己紹介と、各種チャンネルの案内をぜひ。${onboardingReference}`;
}
