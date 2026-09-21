# Privacy policy — v0.2.0

> **Scope**: this document describes the v0.2.0 consent-gated persistence model for
> `ido-bata-server-bot`. It is the runtime contract that
> `ConsentService.authorize(...)` enforces and that
> `/privacy status` / `/privacy delete` surface to end users.
>
> For the source-of-truth scope registry see
> [`src/consent/scopes.ts`](../src/consent/scopes.ts). For the consent
> service implementation see
> [`src/consent/service.ts`](../src/consent/service.ts). For the
> consumer-side gating see
> [`src/features/privacy/consumer-inventory.ts`](../src/features/privacy/consumer-inventory.ts).

## 1. Invariants

1. Discord reactions on a configured consent message are the **UI** for
   grant / revoke. They are never the authorization decision.
2. The authorization decision lives in `ConsentService.authorize(...)`.
   Every consent-gated consumer must call it before any persistent write.
3. **Fail-closed**: any storage corruption, repository unreachable, or
   Discord API failure during authorization returns
   `{ ok: false, reason: "service-unavailable" }`. Consumers MUST treat
   this as a deny — never as a silent allow.
4. **No silent allow on revoke**: removing the reaction stops future
   collection. Existing data is removed only via `/privacy delete` or the
   natural expiry of the underlying storage.
5. **No raw content** (no tokens, no message bodies, no user identifiers
   other than what's strictly needed) leaves the bot through the runtime
   TUI, logs, or `/privacy` responses.

## 2. Scope catalogue

The v0.2.0 release ships these four scopes (centralized in
`src/consent/scopes.ts`):

| Scope                | Semantics                                                        |
| -------------------- | ---------------------------------------------------------------- |
| `activity-history`   | timekeeper attendance, reminders, polls, state-snapshot bundles |
| `presence-history`   | game activity, Spotify now-playing, voice presence (ephemeral)   |
| `profile`           | birthday, profile-like user attributes                             |
| `message-history`    | message audit content, edit/delete history                       |

Adding a new scope is an explicit decision that touches this document,
`src/consent/scopes.ts`, and the relevant consumer wiring — not a single
feature's ad-hoc string.

## 3. Consumer classification (release-0-2-0 inventory)

The classification below covers **every** user-keyed persistent state on
`origin/release-0-2-0` at the time of the v0.2.0 release. Features that
touch only ephemeral or operational data are listed for completeness.

### 3.1 Consent-gated persistent (must go through `ConsentService`)

| Feature             | Persistent file                              | User key         | Personal data                       | Scope               |
| ------------------- | -------------------------------------------- | ---------------- | ----------------------------------- | ------------------- |
| timekeeper (history) | `data/timekeeper-history.json`             | Discord snowflake | per-user ISO attendance dates      | `activity-history`  |
| birthday-role        | `data/birthdays.json`                        | Discord snowflake | `{ userId, date, updatedAt }`      | `profile`           |
| poll                | `data/polls.json`                            | Discord snowflake | `votes: Record<userId, optionIndex>` + creatorId | `activity-history`  |
| reminder            | `data/reminders.json`                        | Discord snowflake | `{ id, userId, message, fireAt, createdAt }` | `activity-history`  |
| state-snapshot      | `data/snapshots/<id>.snap.enc`              | bundled          | encrypted AES-256-GCM mirror of all source files | `activity-history` (special: revoke must trigger snapshot expiry via `applyRetentionPlan`) |

### 3.2 Operational persistent (justified, no consent gate)

| Feature                | Persistent file                              | Justification                                |
| ---------------------- | -------------------------------------------- | -------------------------------------------- |
| timekeeper (session log) | `data/timekeeper-sessions.json`            | session lifecycle, no user id; needed for interrupted-session detection |
| scheduled-announcements | `data/scheduled-announcements.json`          | cadence config, no personal data              |
| config-hot-reload      | `data/config.json`                           | operator-supplied config; no personal data    |
| ical-calendar          | `data/calendars.json` + `data/calendar-cache.json` | guild config + 3rd-party event cache; no Discord user key |
| multi-guild            | `data/guilds/<safeGuildId>/config.json`      | per-guild operator config; no personal data  |

### 3.3 Ephemeral only (no on-disk persistence)

The following 14 features hold state in memory only — nothing about any
Discord user is written to disk by the bot:

- `game-activity`     — current presence (in-memory tracker only)
- `spotify`           — now-playing embed (in-memory state only)
- `member-audit`      — join/leave forwarded to a configured audit channel
- `message-audit`     — edit/delete forwarded to a configured audit channel
- `role-slash`        — audit entry forwarded to a configured channel
- `starboard`         — reposted-message de-duplication set (in-memory)
- `welcome`           — greeting posted to a configured channel
- `github-webhook`    — HTTP request bodies kept in memory only (1 MiB cap)
- `health-metrics`    — Prometheus-format counters (no user id)
- `error-forwarder`   — stack-trace embeds (in-memory rate limit only)
- `slash-commands`    — command metadata
- `slash-permissions` — permission tier table
- `timekeeper-commands` — `/timekeeper` subcommand dispatch
- `shutdown`          — signal handler + teardown chain

These are surfaced to users in `/privacy status` as "ephemeral, no
persistent storage".

## 4. `/privacy` user surface

- `/privacy status` — ephemeral reply. Shows:
  - current `policyVersion`
  - active / revoked / not-granted scope breakdown
  - link/mention to the consent source message
  - per-consumer storage categories (read from
    `src/features/privacy/consumer-inventory.ts`)
- `/privacy delete` — ephemeral prompt. On confirmation, calls
  `ConsentService.clear(subjectId)`. **Partial failures are reported as
  failure, never as success.** Per-scope results are surfaced back to the
  user.

Both are slash-command-subcommand of `/privacy` and declared with
`default_member_permissions = "everyone"` in `src/features/slash-permissions/config.ts`.

## 5. Retention & state-snapshot interaction

`state-snapshot` mirrors every consent-gated file into an encrypted
AES-256-GCM bundle. When a user runs `/privacy delete`, the
`ConsentService.clear()` implementation MUST call `applyRetentionPlan` so
any snapshot whose `collectSourceFiles` manifest contains the revoked
user id is expired. See
[`src/features/state-snapshot/retention.ts`](../src/features/state-snapshot/retention.ts)
and `src/features/privacy/clear.ts` for the wire-up.

## 6. Timekeeper non-consent path

The timekeeper must remain usable in-session even when the user has not
granted consent. The non-consent path:

- `recordCheckIn` stays in-memory (no persistence, no gate).
- `recordAttendance` and `persistSessionAttendance` MUST call
  `ConsentService.authorize(userId, "activity-history")` before any JSON
  write to `data/timekeeper-history.json`.
- A revoke event (`ConsentEvent { kind: "revoke", subjectId }`)
  immediately disables future persistence for that subject — the next
  call returns without touching disk.

The session check-in still happens visually, and the fortune summary
still works (it consumes the in-memory check-in counts).

## 7. Release-0-2-0 reconciliation

On `Events.ClientReady` and on every bot restart, the reconciler at
`src/consent/reconciliation.ts` fetches the configured consent message,
walks reacting users (excluding the bot user), and reconciles the
`ConsentRepository` snapshot against the current Discord reaction state.
Discord API failure during reconciliation adds the affected guild id to
`ReconcileReport.failures` — **no auto-grant on failure**.

## 8. Operator-facing config

| Env var | Effect |
| --- | --- |
| `CONSENT_CHANNEL_ID` | Consent UI を置く Discord text channel。設定すると consent subsystem が有効になる。 |
| `CONSENT_GUILD_ID` | optional guild override。未指定時は `DISCORD_GUILD_ID`。 |
| `CONSENT_MESSAGE_ID` | optional existing-message override。通常は不要。 |
| `CONSENT_EMOJI` | optional emoji/scope mapping。未指定時は4 scope の既定 mapping を使用する。 |
| `CONSENT_POLICY_VERSION` | current policy version。Default `v0.2.0`。 |

`CONSENT_MESSAGE_ID` が空の場合、bot は ClientReady 時に
`CONSENT_CHANNEL_ID` 内の bot-authored managed consent message を探す。
見つかれば current template / policy version に更新して再利用し、
見つからなければ bot 自身が新規投稿する。各 scope の reaction も bot
自身が付与するため、operator 個人の投稿に reaction する必要はない。

既定 mapping:

- 📊 → `activity-history`
- 🟢 → `presence-history`
- 👤 → `profile`
- 💬 → `message-history`

明示した `CONSENT_MESSAGE_ID` が取得不能な場合は、誤って別の consent
message を作らず fail closed とする。