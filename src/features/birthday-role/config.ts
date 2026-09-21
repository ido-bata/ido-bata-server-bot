// Birthday-role feature configuration. All Discord-side identifiers stay in
// this file so tests can replace them through DI.

export type BirthdayRoleConfig = {
  // Discord guild id where the role is granted. Required so a multi-guild
  // deployment does not apply the role in the wrong guild (the cache
  // ordering of `client.guilds.cache.first()` is not stable).
  guildId: string;
  // Discord role granted on the member's birthday.
  roleId: string;
  // Optional text channel that receives an announcement on each member's
  // birthday. Leave as an empty string to disable announcements.
  announcementChannelId: string;
  // Path to the persisted birthday registry. Lives under data/ which is
  // gitignored — see .gitignore.
  dataFile: string;
};

// Replace these placeholder values with real IDs once the role and channel
// exist in your guild. Leaving roleId empty disables the feature gracefully.
export const birthdayRoleConfig: BirthdayRoleConfig = {
  guildId: "",
  roleId: "",
  announcementChannelId: "",
  dataFile: "data/birthdays.json",
};

export function isBirthdayRoleConfigured(config: BirthdayRoleConfig): boolean {
  return config.roleId.length > 0 && config.guildId.length > 0;
}
