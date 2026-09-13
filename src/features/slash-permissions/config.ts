import { isSlashPermissionLevel, type SlashPermissionLevel } from "./policy.js";

export type SlashPermissionRule = {
  /**
   * Slash command name as registered with Discord (matches the `name` field
   * on the command builder / REST payload). Comparison is case-insensitive —
   * Discord normalises slash command names to lowercase.
   */
  commandName: string;
  /**
   * Minimum permission required to invoke the command. `everyone` is the
   * default and means "no Discord permission required beyond being able to
   * use slash commands in the guild".
   */
  level: SlashPermissionLevel;
  /**
   * Free-form rationale for the GitHub Project board. Keep it short — it
   * surfaces in the metadata export and the markdown summary.
   */
  reason: string;
};

/**
 * Authoritative permission map for every slash command the bot registers.
 *
 * Conventions:
 *   - Default is `everyone`. Promote a command only when misuse has a
 *     visible side effect (audit logs, role mutation, channel edits, etc.).
 *   - `administrator` is reserved for destructive or infra-level operations
 *     and should be reviewed alongside `manage_channels`/`manage_messages`.
 *   - When adding a new command, add the rule here in the same change so
 *     the policy and the registration payload stay in lockstep.
 */
export const slashPermissionRules: SlashPermissionRule[] = [
  {
    commandName: "ping",
    level: "everyone",
    reason: "Diagnostic; safe to expose to all members.",
  },
  {
    commandName: "help",
    level: "everyone",
    reason: "Lists registered commands; intentionally public.",
  },
  {
    commandName: "role",
    level: "manage_messages",
    reason: "Self-service role assignment; gated so it cannot be abused to probe role state.",
  },
  {
    commandName: "timekeeper",
    level: "manage_channels",
    reason: "Drives a shared voice session; only moderators should be able to start/stop it.",
  },
  {
    commandName: "announce",
    level: "manage_messages",
    reason: "Posts to announcement channels; restrict to moderators to avoid spam.",
  },
  {
    commandName: "audit",
    level: "administrator",
    reason: "Exposes member/message audit data; restrict to administrators.",
  },
  {
    commandName: "shutdown",
    level: "administrator",
    reason: "Stops the bot process; never expose to non-administrators.",
  },
];

const rulesByCommand = new Map<string, SlashPermissionRule>(
  slashPermissionRules.map((rule) => [rule.commandName.toLowerCase(), rule]),
);

/**
 * Default level applied when a slash command has no explicit rule. The
 * project policy is "fail closed" — a new command is treated as moderator-only
 * until the maintainers deliberately opt it in to `everyone`. This keeps
 * accidental exposure loud rather than silent.
 */
export const DEFAULT_SLASH_PERMISSION_LEVEL: SlashPermissionLevel = "manage_messages";

export function findSlashPermissionRule(commandName: string): SlashPermissionRule | undefined {
  return rulesByCommand.get(commandName.toLowerCase());
}

/**
 * Resolves the effective permission level for a slash command, applying
 * the default when no explicit rule exists. Exposed as a single entry point
 * so the dispatcher, the deploy script, and the metadata export cannot drift.
 */
export function resolveSlashPermissionLevel(commandName: string): SlashPermissionLevel {
  return findSlashPermissionRule(commandName)?.level ?? DEFAULT_SLASH_PERMISSION_LEVEL;
}

/**
 * Validates that every entry in `slashPermissionRules` carries a known
 * permission level. Called at module load and at deploy time so a typo in
 * the rule list fails fast instead of registering a command with `0`.
 */
export function validateSlashPermissionRules(rules: SlashPermissionRule[]): void {
  const seen = new Set<string>();

  for (const rule of rules) {
    if (!rule.commandName) {
      throw new Error("validateSlashPermissionRules: rule is missing commandName");
    }

    const key = rule.commandName.toLowerCase();

    if (seen.has(key)) {
      throw new Error(
        `validateSlashPermissionRules: duplicate rule for command "${rule.commandName}"`,
      );
    }
    seen.add(key);

    if (!isSlashPermissionLevel(rule.level)) {
      throw new Error(
        `validateSlashPermissionRules: unknown level "${rule.level}" for command "${rule.commandName}"`,
      );
    }

    if (typeof rule.reason !== "string" || rule.reason.length === 0) {
      throw new Error(
        `validateSlashPermissionRules: rule for "${rule.commandName}" is missing a reason`,
      );
    }
  }
}

// Fail fast on import: a malformed rule list is a release-blocker, not a
// runtime surprise.
validateSlashPermissionRules(slashPermissionRules);
