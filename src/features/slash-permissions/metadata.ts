import { type SlashPermissionRule, slashPermissionRules } from "./config.js";
import { defaultMemberPermissionsFor, type SlashPermissionLevel } from "./policy.js";

export type SlashPermissionMetadataEntry = {
  commandName: string;
  level: SlashPermissionLevel;
  defaultMemberPermissions: string;
  reason: string;
};

/**
 * Stable, JSON-friendly snapshot of the permission ruleset. The shape is
 * deliberately flat so a GitHub Project automation (or any other consumer)
 * can ingest it without bespoke parsing.
 */
export function buildSlashPermissionMetadata(): SlashPermissionMetadataEntry[] {
  return slashPermissionRules
    .map<SlashPermissionMetadataEntry>((rule: SlashPermissionRule) => ({
      commandName: rule.commandName,
      level: rule.level,
      defaultMemberPermissions: defaultMemberPermissionsFor(rule.level),
      reason: rule.reason,
    }))
    .sort((a, b) => a.commandName.localeCompare(b.commandName));
}

/**
 * Markdown table suitable for pasting into a GitHub Issue, Project board, or
 * release notes. Columns are kept narrow on purpose so the table renders
 * inside a Project card without horizontal scrolling.
 */
export function renderSlashPermissionMarkdown(
  entries: SlashPermissionMetadataEntry[] = buildSlashPermissionMetadata(),
): string {
  const header =
    "| command | level | default_member_permissions | reason |\n| --- | --- | --- | --- |";
  const rows = entries.map(
    (entry) =>
      `| \`/${entry.commandName}\` | ${entry.level} | ${entry.defaultMemberPermissions} | ${entry.reason} |`,
  );
  return [header, ...rows].join("\n");
}
