export type TimekeeperCommandsConfig = {
  /**
   * Discord role ID allowed to run the moderator-only `/timekeeper`
   * subcommands (`next`, `pause`, `resume`, `skip`). Empty string means
   * "moderator role not configured" — the handler then falls back to the
   * guild owner / administrator permission bit on each invocation.
   */
  moderatorRoleId: string;
};

export const timekeeperCommandsConfig: TimekeeperCommandsConfig = {
  // Replace this placeholder with the actual moderator role ID before the
  // feature does anything in production. The handler treats an empty string
  // as "no moderator role configured" and falls back to the
  // `PermissionsBitField.Flags.Administrator` check.
  moderatorRoleId: "",
};

export function isModeratorRoleConfigured(config: TimekeeperCommandsConfig): boolean {
  return config.moderatorRoleId.length > 0;
}
