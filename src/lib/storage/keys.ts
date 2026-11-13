/**
 * Canonical storage keys.
 *
 * Every persisted artefact of the bot lives under one of these keys. The
 * mapping is intentionally flat: `data/<file>` on the filesystem becomes
 * `<file>` in the storage backend, so a local `data/` directory and a U3
 * bucket hold the same layout and a migration is a straight copy.
 */

export const STORAGE_KEYS = {
  /** Anonymous-chat audit records (one object per record). */
  anonAuditDir: "anon-audit",
  /** Mandatory custodian operation log for `/anon` audit operations. */
  anonAuditOperations: "anon-audit/operations.jsonl",
  /** Registered birthdays. */
  birthdays: "birthdays.json",
  /** iCal event cache. */
  calendarCache: "calendar-cache.json",
  /** Hot-reloadable operator configuration. */
  config: "config.json",
  /** Consent registry — the authorization source of truth. */
  consent: "consent.json",
  /** Per-guild operator configuration. */
  guildsDir: "guilds",
  /** Instance lease that prevents two bots from processing events at once. */
  instanceLease: "locks/instance.json",
  /** Poll definitions and votes. */
  polls: "polls.json",
  /** Reminders. */
  reminders: "reminders.json",
  /** Scheduled announcement cadence. */
  scheduledAnnouncements: "scheduled-announcements.json",
  /** Encrypted state-snapshot bundles. */
  snapshotsDir: "snapshots",
  /** Timekeeper attendance history. */
  timekeeperHistory: "timekeeper-history.json",
  /** Timekeeper session lifecycle log. */
  timekeeperSessions: "timekeeper-sessions.json",
} as const;
