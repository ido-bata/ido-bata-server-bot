# Architecture

Deep-dive reference for `ido-bata-server-bot`. Read this after `CLAUDE.md` or `AGENTS.md`.

The bot runtime is Node via `tsx`, **not** Bun. This is intentional — Discord voice is more reliable on Node. Bun is only used to install deps and run scripts.

## Composition root

`src/index.ts` reads config, creates the Discord client, then registers feature handlers. The `Client` is the only shared dependency — each feature registers its own event listeners.

```text
src/index.ts
├── createDiscordClient(...)            # src/bot/create-discord-client.ts
├── readConfig(process.env)             # src/config.ts
├── registerReactionRoleHandlers(...)   # src/features/reaction-roles/handler.ts
├── registerTimekeeper(...)             # src/features/timekeeper/service.ts
└── registerGameActivity(...)           # src/features/game-activity/handler.ts
```

## Layout

- `src/index.ts` — composition root
- `src/config.ts` — Zod-validated env → `BotConfig`
- `src/bot/create-discord-client.ts` — constructs `Client` with intents (`Guilds`, `GuildMessages`, `GuildMessageReactions`, `GuildVoiceStates`; adds `MessageContent` only when enabled; adds `GuildMembers` only when enabled — required for the member-audit feature to receive `GuildMemberAdd` / `GuildMemberRemove`; adds `GuildPresences` only when explicitly enabled via env — required for the spotify and game-activity features to receive `PresenceUpdate`)
- `src/features/game-activity/` — Discord Rich Presence → "X 人 playing <game>" summary
  - `config.ts` — whitelist of game names (case-insensitive), target channel id, 5-minute stale window, 60-second refresh cadence
  - `tracker.ts` — `GameActivityTracker` keeps the last observation per user; `evict()` drops anything older than the stale threshold; `snapshot()` returns a deterministic per-game aggregation sorted by player count then name
  - `formatter.ts` — `formatGameActivityMessage` renders the headline + per-game lines with `<@userId>` mentions; `summarizeGameActivity` is the short variant used by future slash commands
  - `handler.ts` — `createGameActivityHandler(config, deps)` returns the testable handle; `registerGameActivity(client, config, deps)` wires `Events.PresenceUpdate` and starts the refresh interval. Requires `DISCORD_ENABLE_PRESENCE=true` and the privileged intent enabled in the Discord Developer Portal.
- `src/features/reaction-roles/` — `config.ts` holds the rule list; `handler.ts` registers `MessageReactionAdd`/`Remove` listeners. Uses a DI seam (`HandlerDependencies`) so the role-lookup and member-fetch logic can be replaced in tests
- `src/features/timekeeper/` — daily pomodoro-style scheduler. Submodules:
  - `config.ts` — JST start time, channel IDs, phase list
  - `schedule.ts` — JST-aware next-start computation
  - `timeline.ts` — builds the event timeline (`work-start-soon`, `phase-start`, `phase-ending-soon`, `break-start`, `session-end`) and the progress-message formatter
  - `service.ts` — orchestrator: schedules, joins voice, plays audio, posts/edits progress messages, records attendance
  - `session-clock.ts` — `createSessionClock`, `getDelayFor`, `clampTimeToEvent`, `getTimelineNow`, `findTimelineStartIndex`; switches between wall-clock and compressed minute scales
  - `playback-budget.ts` — `resolvePlaybackTimeouts` bounds the audio player's start/finish waits so a stalled player cannot overrun the gap between events
  - `engagement.ts` — check-in buttons, attendance persistence (`data/timekeeper-history.json`), Wikipedia-powered fortune summary at session end
  - `wikipedia.ts` — fetches a random JA Wikipedia topic with a hardcoded fallback
  - `voice-debug.ts` — structured JSON logging around `@discordjs/voice` (errors only by default; state-change handlers are commented out)
- `src/features/spotify/` — opt-in Now Playing display. Submodules:
  - `config.ts` — env-driven (`DISCORD_ENABLE_SPOTIFY`, `SPOTIFY_VISIBILITY`, `SPOTIFY_CHANNEL_ID`, `SPOTIFY_STALE_AFTER_MS`); `visibility: "self"` DMs the listener, `"public"` posts into a configured channel
  - `activity.ts` — `parseSpotifyActivity`, `isSpotifyActivity`; identifies the Spotify `Listening` activity regardless of whether Discord labels it by `name` or `applicationId`
  - `formatter.ts` — `formatNowPlayingEmbed`, `formatStoppedEmbed`; pure functions producing the embed title/description shown in Discord
  - `state.ts` — `NowPlayingStore` keeps per-listener `{track, embedMessageId, lastUpdatedAt}` and prunes stale entries on demand
  - `handler.ts` — `createSpotifyNowPlayingHandler(deps)` factory; DI seams (`sendEmbed` / `editEmbed` / `deleteEmbed` / `now`) so the lifecycle is unit-testable without Discord
  - `service.ts` — `registerSpotifyNowPlaying(client, config)` wires `Events.PresenceUpdate` + a 60 s `setInterval` prune; logs and no-ops if the feature is not configured
- `src/scripts/stage-audio-smoke.ts` — joins the configured voice channel, plays the first timeline clip, then exits
- `src/scripts/stage-audio-smoke.ts` — joins the configured voice channel, plays the first timeline clip, then exits
- `tests/` — vitest specs that mirror `src/` layout (`config.test.ts`, `timekeeper-timeline.test.ts`, `timekeeper-engagement.test.ts`, etc.)

## Persistence layer (`src/lib/storage/`)

Every persisted artefact of the bot goes through one port,
`StorageDriver` (`src/lib/storage/types.ts`):

```text
read / readText / readVersioned / write / writeExclusive /
compareAndSwap / list / delete / exists / move / probeConditionalWrites
```

The following adapters implement it:

| Adapter | Backend | Used when |
| --- | --- | --- |
| `LocalFileStorage` | files under `DATA_DIR` (default `<cwd>/data`) | `STORAGE_BACKEND=local` (default) |
| `U3Storage` | S3-compatible object storage (Altare U3) | `STORAGE_BACKEND=u3` |
| `ValkeyStorage` | Redis-compatible store (Altare Valkey) — lease backend; U3 ignores S3 conditional writes | `LEASE_STORAGE_BACKEND=valkey` |

Semantics are identical on every adapter, and `tests/storage-contract.test.ts`
runs the same contract against each configured backend (Valkey only when
`VALKEY_TEST_URL` points at a real instance):

- `write` replaces an object atomically (temp file + `rename(2)` locally,
  a single `PUT` on object storage) — a reader never sees a half-written
  document.
- `writeExclusive` creates only when the key is free and never
  overwrites — the audit records and the instance lease depend on it.
- A missing key reads as `null`; **every other failure throws**. Callers
  treat a throw as "storage unavailable" and fail closed.
- `compareAndSwap` writes only when the stored version still matches the
  one the caller read; `probeConditionalWrites` reports whether the
  backend can enforce conditions at all. The instance lease depends on
  both — a backend without conditional writes stops the bot.

Consumers (all of them): consent registry (`consent.json`), timekeeper
attendance + session log, `/anon` audit records + custodian operation log,
state-snapshot bundles, birthday registry, polls, reminders, scheduled
announcements, per-guild configuration, calendar source configuration and
cache, hot-reload configuration.

Key layout is flat and identical in every backend — `data/consent.json`
locally, `consent.json` in the bucket — so a migration is a straight copy
(`bun run storage:migrate`, see `docs/operations/altare-migration.md`).

### Instance lease

`src/lib/storage/lease.ts` implements a single-instance guard:

- the lease object carries a monotonic `epoch` and a per-term `token`;
- acquisition, renewal and release are **compare-and-swap** writes, so a
  takeover cannot slip through a read-then-write window;
- release *expires* the term instead of deleting the object — a delete
  could remove a term another instance just acquired;
- the backend is probed at startup; a backend that cannot enforce
  conditional writes stops the bot (fail closed);
- a lost lease shuts the bot down with exit code 1 — it never keeps
  running unowned;
- the lease backend is configured independently of the data backend
  (`LEASE_STORAGE_BACKEND`), so the old host and the Altare deployment
  contend for the *same* lease during a cutover.

A live lease held by another instance aborts the startup — the old host
and the Altare deployment can therefore never process the same event
twice.

### Deletion ledger

`src/lib/storage/deletions.ts` records every privacy deletion as an
HMAC-SHA256 digest of the subject id (`privacy/deletions.json`). The
ledger is append-only: a restore merges it and re-applies the recorded
erasures (`src/lib/storage/erasure.ts`), so restoring an old backup cannot
resurrect data a user asked to forget.

## Container runtime

The bot ships a multi-stage `Containerfile` and a single-service `compose.yml`. The image targets are kept in `src/features/container/target.ts` so CI and local scripts can resolve them through the same code path.

```text
Containerfile (multi-stage)
├── base       node:22-slim + Bun + tsx on PATH
├── deps       base + `bun install --frozen-lockfile` (production deps)
├── build      deps + `bun run build` → dist/
└── runtime    node:22-slim + dist/ (from build) + node_modules (from deps)
```

The `runtime` stage is what `compose.yml` builds. Its entrypoint is `node dist/index.js`, so the runtime image does not need TypeScript or `tsx`. The `runtime` image exposes port `8080` for the `/health` endpoint added by issue #26; the bundled `HEALTHCHECK` and the compose-level `healthcheck:` both probe it on a 30s interval.

Compose loads secrets from `.env` via `env_file:` — `DISCORD_TOKEN` and friends are never `COPY`'d into a layer, and `.dockerignore` blocks `.env`/`.env.*` from the build context. Local persisted state (`data/timekeeper-history.json`) is mounted from a named volume (`bot-data`) so the attendance log survives container restarts.

The CI workflow builds the `runtime` image on every PR that touches `Containerfile` / `compose.yml` / `.dockerignore`, asserts the image is under the 300 MB budget, and validates `compose.yml` with `docker compose config`. Container changes must keep that gate green.

## Timekeeper timeline model

`buildTimekeeperTimeline()` in `src/features/timekeeper/timeline.ts` constructs exactly 12 events for the default 5-phase config. Each event has a numeric `order` (1–12) that maps to a WAV filename in `tmp-audio/`:

- `NNN_<name>.wav` where `NNN` is the zero-padded `order`
- Files are listed via `readdirSync` and matched by the leading 3-digit prefix
- Missing audio files throw at session start

Adding/reordering phases requires updating both `timekeeperConfig.phases` and the 12-event list in `buildTimekeeperTimeline` (it indexes `phases[0..4]` directly — extending beyond 5 phases requires editing that function).

## Timekeeper stage-channel quirks

Stage channels (`ChannelType.GuildStageVoice`) need extra handling in `service.ts`:

1. `prepareStageSpeaker` unsuppresses the bot (or requests to speak if unsuppress fails)
2. `connectForPlayback` destroys the connection and reconnects after suppression, because audio relay often fails on the first join
3. `refreshStageSpeakerBeforePlayback` re-unsuppresses before every clip

If you change voice behavior, leave these workarounds in place until you confirm the underlying `@discordjs/voice` issue is resolved.

## Timekeeper session clock

`createSessionClock` (in `session-clock.ts`) drives two time scales:

- **wall-clock mode**: scheduled sessions — delays match real time
- **mid-session resume / `TIMEKEEPER_RUN_ON_READY=true`**: minute durations are compressed to 1 second so the whole session runs in ~minutes instead of ~100 minutes

`getDelayFor` switches between these modes. Any new time-based behavior should respect `clock.minuteMs` rather than hardcoding `60_000`.

## Engagement state

`activeSession` and `activeTimeline` are module-level singletons in `service.ts`. They back the check-in button handler and the fortune summary. They reset to `null`/`[]` at session end. Be careful with concurrent sessions — only one can be active at a time.

## Reaction roles

Rules live in `src/features/reaction-roles/config.ts`. Each rule is `{ messageId, emoji, roleId }` — placeholder IDs must be replaced with real Discord IDs before the feature does anything. `toEmojiKey` resolves a custom emoji by ID or falls back to its unicode name.

The handler factory `createReactionRoleHandler(deps)` accepts `findRule` and `withMemberRoleManager` overrides; tests use these instead of touching the Discord API.

## v0.2.0 additions

### `src/lib/logger/` — structured logger

Pino-based root logger (`createRootLogger`) with a bounded `LogRingBuffer` and an in-process subscriber seam (`subscribe(fn)` returns an unsubscribe). Subscribers receive frozen `NormalizedLogEvent` snapshots; subscriber exceptions are swallowed so a buggy listener cannot crash the bot. Pino options redact `*.discordToken`, `*.token`, `*.password`. The composition root creates one root logger and hands out children via `childFor(logger, feature, event?)`. No `console.*` in `src/` normal path; one explicit `console.error` fallback for pre-logger-init bootstrap.

### `src/consent/` — Consent Registry

`ConsentService` (`createConsentService`) is the SoT for authorization. `authorize(subjectId, scope)` is fail-closed: any storage or API failure returns `{ ok: false, reason: "service-unavailable" }`. Reaction handler (`createReactionHandler`) bridges `MessageReactionAdd` / `MessageReactionRemove` to grant/revoke. Reconciler (`reconcileConsentsOnReady`) fetches the configured consent message on `ClientReady` and rewrites the JSON repository to match Discord's current state. Repository is a versioned JSON file with atomic temp+rename writes. `docs/privacy.md` enumerates the scope catalogue and consumer classification.

### `src/runtime/` — RuntimeStatusStore

Read model that backs the TUI dashboard. Frozen snapshot shape: `{ app, discord, features, consent, timekeeper, runtime, events }`. `subscribe(listener)` returns an unsubscribe; the listener receives a fresh frozen snapshot on every change. The `events` slice is a bounded FIFO ring buffer (`EVENTS_CAP_MIN=10..EVENTS_CAP_MAX=10_000`, default 200). The composition root writes into the store from feature modules and Discord lifecycle events; the TUI is a pure consumer.

### `src/tui/` — runtime dashboard

Ink 7 + React 19.2 dashboard with 7 panels (header, discord, features, consent, timekeeper, runtime, events). Render gate (`mountTui`) honors `BOT_TUI=auto|on|off`; `auto` follows TTY detection (`stdout.isTTY && stdin.isTTY && TERM !== "dumb" && !CI`). When TUI is off, the structured logger continues to write JSON Lines via pino — no Ink render is invoked. Ctrl+C is forwarded to `useApp().exit()`; the actual SIGINT/SIGTERM teardown stays in `src/features/shutdown/handler.ts`. No interactive keybinds (monitoring only). `useSyncExternalStore` for store changes; 1 Hz `useReducer` tick for uptime and RSS.

### `src/features/privacy/` — privacy surface

Typed mirror of `docs/privacy.md` (§ 3): `consumer-inventory.ts` enumerates 26 entries (6 consent-gated, 5 operational, 15 ephemeral). `clear.ts` aggregates per-consumer delete adapters; partial failure is reported as failure (never silent success). `/privacy status` and `/privacy delete` are subcommands of `/privacy` and declared with `default_member_permissions = "everyone"`. State-snapshot revoke wires `applyRetentionPlan` so any snapshot whose source files contained the revoked user id is expired.

### `src/features/anonymous-chat/` — `/anon` anonymous repost (Issue #108, ADR-0003)

`/anon message:<body>` reposts into the invoking channel/thread with `allowedMentions: { parse: [] }` and no author identity. Authorization is an effective-permission check ("could this member post normally here"): `permissions.ts` mirrors discord.js overwrite resolution and resolves threads through their parent channel (Discord threads carry no overwrites of their own); `locked !== false`, private-thread non-membership (user and bot may alternatively hold `ManageThreads`), unresolved channels/members, and bot permission gaps all fail closed, and all Discord lookups use `force` refreshes. `rate-limit.ts` is an in-memory 30 s per-user cooldown (never persisted/logged). `audit-crypto.ts` + `audit-store.ts` implement the opt-in audit mapping: RSA-OAEP public-key-only encryption (private-key material is rejected) into per-record immutable files under `data/anon-audit/` (`0600`/`0700`; atomic `wx` creation needs no lock — sweep only touches expired dates and custodian deletion removes whole files) with bounded retention — the `{v,gid,cid,ct}` record is written BEFORE the public send so no anonymous message can exist without a durable audit record, and records carry ciphertext only with NO bot-computable per-user index (deterministic tags would be dictionary-attackable over public guild rosters); selective deletion is an offline custodian operation (`bun run anon:audit:delete`), and the bot-side `/privacy delete` consumer reports an honest failure when records exist. Unset `ANON_AUDIT_PUBLIC_KEY` means zero persistence; a configured-but-broken audit refuses all posts (`auditState: "error"`, never silent ephemeral fallback). The command defers ephemerally, catches every error, and replies via generic ephemeral edits — nothing reaches the unguarded interaction dispatcher or error-forwarder with user-identifying data, and all logged error fields pass through `safeErrorFields` (`errName`/`errCode`/`errStatus` only).
