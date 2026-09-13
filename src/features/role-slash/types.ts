import type {
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";

// Anything that exposes a `toJSON` method (SlashCommandBuilder,
// SlashCommandSubcommandsOnlyBuilder, …). Using a structural alias keeps the
// contract narrow while accepting both builder flavours.
export type ToJSONCapable = { toJSON: () => RESTPostAPIChatInputApplicationCommandsJSONBody };

export type SlashCommandDefinition = {
  // Stable id used both as the registration payload name and the dispatch key.
  name: string;
  description: string;
  // Produces the Discord REST payload. Accepts either a raw payload object or
  // a builder that exposes `toJSON()` (e.g. `SlashCommandBuilder` or
  // `SlashCommandSubcommandsOnlyBuilder`).
  buildPayload: () => RESTPostAPIChatInputApplicationCommandsJSONBody | ToJSONCapable;
  // Executes against a real interaction. Pure for inputs, but side-effects are
  // funneled through the reply helper (see `HandlerDependencies`).
  execute: (context: {
    interaction: ChatInputCommandInteraction;
    commandName: string;
  }) => Promise<unknown> | unknown;
};

export type SlashCommandRegistry = {
  definitions: SlashCommandDefinition[];
  find: (name: string) => SlashCommandDefinition | undefined;
};

export type RoleAction = "assign" | "remove";

export type RoleAssignmentResult =
  | { ok: true; action: RoleAction; roleId: string }
  | { ok: false; reason: RoleAssignmentError };

export type RoleAssignmentError =
  | "not_assignable"
  | "no_change"
  | "permission_denied"
  | "missing_role"
  | "role_not_found"
  | "internal_error";

export type RoleAssignmentContext = {
  guildId: string;
  userId: string;
  roleId: string;
};

export type RoleAssignmentDependencies = {
  // Look up a rule by roleId. Should return the matching rule or null when the
  // role is not configured for slash-assignment.
  findRuleByRoleId?: (roleId: string) => unknown;
  // Permission gate. Defaults to true for backward compatibility. Tests can
  // inject a mock that simulates the moderator check.
  isPermitted?: (interaction: ChatInputCommandInteraction) => boolean;
  // Member role manager seam mirroring the reaction-roles handler.
  withMemberRoleManager?: <T>(
    guildId: string,
    userId: string,
    run: (roles: RoleManagerLike) => Promise<T>,
  ) => Promise<T | undefined>;
  // True when the user currently has the role. Lets the handler distinguish
  // between `already has it` and `does not have it`.
  hasRole?: (guildId: string, userId: string, roleId: string) => Promise<boolean>;
  // Audit sink. Default is a no-op so tests do not have to provide one.
  audit?: (entry: RoleAuditEntry) => Promise<void> | void;
};

export type RoleManagerLike = {
  add: (roleId: string) => Promise<unknown>;
  remove: (roleId: string) => Promise<unknown>;
};

export type RoleAuditEntry = {
  action: RoleAction;
  guildId: string;
  userId: string;
  roleId: string;
  result: "success" | "skipped" | "error";
  reason?: string;
};