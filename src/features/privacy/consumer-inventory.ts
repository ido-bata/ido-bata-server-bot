/**
 * Typed mirror of `docs/privacy.md` § 3. This is the runtime source of
 * truth for `/privacy status` (which consumer categories are stored and
 * how they map to scopes) and for `ConsentService.clear` (which per-
 * consumer delete adapter to invoke for which subject).
 *
 * If a feature adds new user-keyed persistence, both `docs/privacy.md`
 * and this table MUST be updated together.
 */
import type { ConsentScope } from "../../consent/scopes.js";

export type ConsumerBucket = "consent-gated" | "operational" | "ephemeral";

export type ConsumerEntry = {
  /** stable identifier — also used as `ConsumerDeleteAdapter` key. */
  id: string;
  /** feature label shown in `/privacy status`. */
  label: string;
  /** consent-gated / operational / ephemeral. */
  bucket: ConsumerBucket;
  /** scope required for consent-gated consumers. undefined for the other buckets. */
  scope?: ConsentScope;
  /** file path under `data/` for persistent consumers. */
  dataFile?: string;
  /** short rationale shown in `/privacy status` (especially for operational). */
  rationale?: string;
};

/**
 * The canonical consumer list. Order is intentional — it is the order
 * shown in `/privacy status` and the order `clear()` iterates when a user
 * runs `/privacy delete`.
 */
export const CONSUMERS: readonly ConsumerEntry[] = [
  // Consent-gated (5)
  { id: "timekeeper-history", label: "Timekeeper attendance history",
    bucket: "consent-gated", scope: "activity-history",
    dataFile: "data/timekeeper-history.json" },
  { id: "birthday",          label: "Birthday profile",
    bucket: "consent-gated", scope: "profile",
    dataFile: "data/birthdays.json" },
  { id: "poll",              label: "Poll votes",
    bucket: "consent-gated", scope: "activity-history",
    dataFile: "data/polls.json" },
  { id: "reminder",          label: "Reminders",
    bucket: "consent-gated", scope: "activity-history",
    dataFile: "data/reminders.json" },
  { id: "state-snapshot",    label: "Encrypted state snapshots",
    bucket: "consent-gated", scope: "activity-history",
    dataFile: "data/snapshots/",
    rationale: "Encrypted AES-256-GCM bundles of source files; expiry triggered via applyRetentionPlan" },

  // Operational (5)
  { id: "timekeeper-session-log", label: "Timekeeper session log",
    bucket: "operational",
    dataFile: "data/timekeeper-sessions.json",
    rationale: "Session lifecycle (interrupted/completed/cancelled); no user id" },
  { id: "scheduled-announcements", label: "Scheduled announcements cadence",
    bucket: "operational",
    dataFile: "data/scheduled-announcements.json",
    rationale: "Operator-supplied cadence; no personal data" },
  { id: "config-hot-reload",      label: "Hot-reload operator config",
    bucket: "operational",
    dataFile: "data/config.json",
    rationale: "Channel/role ids supplied by the operator" },
  { id: "ical-calendar",          label: "iCal calendar cache",
    bucket: "operational",
    dataFile: "data/calendars.json + data/calendar-cache.json",
    rationale: "Guild config + 3rd-party event cache; no Discord user key" },
  { id: "multi-guild",            label: "Per-guild operator config",
    bucket: "operational",
    dataFile: "data/guilds/<safeGuildId>/config.json",
    rationale: "Per-guild operator config; no personal data" },

  // Ephemeral (14) — listed for completeness; no on-disk storage
  { id: "game-activity",   label: "Game activity (presence)",     bucket: "ephemeral", scope: "presence-history" },
  { id: "spotify",         label: "Spotify now-playing (presence)", bucket: "ephemeral", scope: "presence-history" },
  { id: "member-audit",    label: "Member join/leave audit",       bucket: "ephemeral" },
  { id: "message-audit",   label: "Message edit/delete audit",     bucket: "ephemeral", scope: "message-history" },
  { id: "role-slash",      label: "Role assignment audit",         bucket: "ephemeral" },
  { id: "starboard",       label: "Starboard reposts",             bucket: "ephemeral" },
  { id: "welcome",         label: "Welcome messages",              bucket: "ephemeral" },
  { id: "github-webhook",  label: "GitHub webhook dispatcher",     bucket: "ephemeral" },
  { id: "health-metrics",  label: "Prometheus-format metrics",     bucket: "ephemeral" },
  { id: "error-forwarder", label: "Error stack forwarding",        bucket: "ephemeral" },
  { id: "slash-commands",  label: "Slash command metadata",        bucket: "ephemeral" },
  { id: "slash-permissions", label: "Slash permission rules",      bucket: "ephemeral" },
  { id: "timekeeper-commands", label: "Timekeeper slash dispatch", bucket: "ephemeral" },
  { id: "shutdown",        label: "Signal-handler teardown",       bucket: "ephemeral" },
];

export function getConsumers(): readonly ConsumerEntry[] {
  return CONSUMERS;
}

export function getConsentGatedConsumers(): readonly ConsumerEntry[] {
  return CONSUMERS.filter((c) => c.bucket === "consent-gated");
}

export function getConsumerById(id: string): ConsumerEntry | undefined {
  return CONSUMERS.find((c) => c.id === id);
}