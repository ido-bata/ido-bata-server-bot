/**
 * Single source of truth for the consent scope strings used by
 * `ConsentService.authorize()` and `docs/privacy.md`.
 *
 * The v0.2.0 release ships these four scopes:
 *
 * - `activity-history` — timekeeper attendance, reminders, polls
 * - `presence-history` — game activity, Spotify now-playing, voice presence
 * - `profile`          — birthday, profile-like user attributes
 * - `message-history`  — message audit content, edit/delete history
 *
 * Adding a new scope is an explicit decision: the privacy classification in
 * `docs/privacy.md` and the consumer wiring in `src/features/privacy/`
 * must be updated together. Do not introduce ad-hoc scope strings inside
 * a single feature handler.
 */
export const CONSENT_SCOPES = [
  "activity-history",
  "presence-history",
  "profile",
  "message-history",
] as const;

export type ConsentScope = (typeof CONSENT_SCOPES)[number];

export function isConsentScope(value: unknown): value is ConsentScope {
  return typeof value === "string" && (CONSENT_SCOPES as readonly string[]).includes(value);
}

/** Default policy version for v0.2.0. Bump on privacy-policy changes. */
export const DEFAULT_POLICY_VERSION = "v0.2.0";
