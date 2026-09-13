import { roleCommand } from "./commands.js";
import type { SlashCommandDefinition, SlashCommandRegistry } from "./types.js";

export type { SlashCommandRegistry } from "./types.js";

// Seeded with the role command so the deployment and dispatch layers have
// something concrete to work with out of the box. The execute function is
// intentionally a no-op so callers that wire their own dependencies (e.g.
// `createRoleSlashHandler`) can rebind it before dispatch.
const defaultDefinitions: SlashCommandDefinition[] = [
  {
    name: roleCommand.name,
    description: roleCommand.description,
    buildPayload: () => roleCommand.buildPayload(),
    execute: () => undefined,
  },
];

export function createRoleSlashCommandRegistry(
  definitions: SlashCommandDefinition[] = defaultDefinitions,
): SlashCommandRegistry {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));

  return {
    definitions: [...definitions],
    find: (name: string) => byName.get(name),
  };
}