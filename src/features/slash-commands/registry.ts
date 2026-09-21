import { helpCommand } from "./commands/help.js";
import { pingCommand } from "./commands/ping.js";
import { privacyCommand } from "./commands/privacy.js";
import type { SlashCommandDefinition, SlashCommandRegistry } from "./types.js";

export type { SlashCommandRegistry } from "./types.js";

// The order is intentional — `help` renders the registry list, so we keep the
// seed list stable and explicit here.
const defaultDefinitions: SlashCommandDefinition[] = [pingCommand, helpCommand, privacyCommand];

export function createSlashCommandRegistry(
  definitions: SlashCommandDefinition[] = defaultDefinitions,
): SlashCommandRegistry {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));

  return {
    definitions: [...definitions],
    find: (name: string) => byName.get(name),
  };
}
