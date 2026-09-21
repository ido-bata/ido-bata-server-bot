// Tunable limits for the personal reminder feature. Values are exportable so
// tests (and the slash-command `execute` helper) can re-use them without
// importing the literal numbers directly.

export type ReminderConfig = {
  /**
   * Maximum number of reminders a single user can have queued at the same
   * time. Exceeding this is rejected by the slash command with an ephemeral
   * error so the user can prune their queue first.
   */
  maxPerUser: number;
  /**
   * Longest allowed `duration` for a single reminder. Reminders farther into
   * the future than this are rejected so the persistence file stays small and
   * the scheduler can rely on a bounded window.
   */
  maxDurationMs: number;
};

export const reminderConfig: ReminderConfig = {
  // 10 reminders per user keeps the JSON file bounded; spec calls for this to
  // be configurable through `reminderConfig` here.
  maxPerUser: 10,
  // 7 days, matching the issue's acceptance criteria (`上限 7d`).
  maxDurationMs: 7 * 24 * 60 * 60 * 1_000,
};

/**
 * Smallest fire window we accept: 1 second. This stops the duration parser
 * from emitting reminders that round to "right now", which would race the
 * scheduler's reload-on-startup logic.
 */
export const MIN_DURATION_MS = 1_000;
