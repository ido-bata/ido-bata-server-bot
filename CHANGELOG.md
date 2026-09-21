# Changelog

All notable changes to this project are documented here. Versions follow [Semantic Versioning](https://semver.org/) — see [`docs/process.md`](./docs/process.md) for the release-bound cadence.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses the following categories:

- **Added** — new features
- **Changed** — changes to existing functionality
- **Deprecated** — soon-to-be removed features
- **Removed** — now-removed features
- **Fixed** — bug fixes
- **Security** — vulnerability fixes

## [0.2.0] — 2026-09-21

### Added

- **Structured logger + TUI log sink (#8)**: pino-based root logger with bounded ring buffer, in-process subscriber seam for downstream consumers. `LOG_LEVEL` and `LOG_RING_SIZE` env vars. Pino redact paths for tokens/passwords. New `src/lib/logger/` module; all `src/` console.* replaced.
- **Consent Registry (#93)**: Discord-reaction-driven opt-in. `ConsentService.authorize()` is the SoT for authorization; reaction handler wires Discord `MessageReactionAdd` / `MessageReactionRemove` to grant/revoke; reconciler runs on `ClientReady`. Atomic JSON repository at `data/consent.json` (gitignored). Four scopes: `activity-history`, `presence-history`, `profile`, `message-history`.
- **Privacy integration (#94)**: every user-keyed persistent consumer gated through `ConsentService.authorize()`. `/privacy status` (ephemeral: active/revoked scope breakdown + per-consumer storage categories) and `/privacy delete` (cascade delete with partial-fail = failure semantics). `applyDefaultMemberPermissions` wired into slash deploy so `slashPermissionRules` actually reach Discord. `applyRetentionPlan` triggered on revoke for state-snapshot. Timekeeper in-session check-ins remain non-consent (memory only); persistence gated.
- **Runtime TUI dashboard (#95)**: Ink 7 + React 19.2 dashboard with 7 panels (header, discord, features, consent, timekeeper, runtime, events). `BOT_TUI=auto|on|off` env gate; `auto` follows TTY detection. `RuntimeStatusStore` is the read model; subscribers get frozen snapshots. Pino subscriber feeds the events ring buffer. Ctrl+C forwarded to existing shutdown handler. Non-TTY falls back to JSON Lines via pino.
- **ADR templates**: docs/adr/0000 (template), 0001 (agent dispatching model), 0002 (weekly sprint + merge auth boundary) — carried over from `main`.
- **Operational persistent features** (carried from prior work, never landed on main until now):
  multi-guild (per-guild config + listener registry), GitHub Webhook receiver (release / PR / issues → Discord embed), iCal calendar ingest + `/calendar list`, game-activity whitelist, Spotify now-playing embed, member-audit, message-audit, role-slash with audit forwarding, starboard, scheduled-announcements, slash-permissions (deploy wire-up), config-hot-reload, welcome messages, state-snapshot (AES-256-GCM bundles), health-metrics (Prometheus-format).

### Changed

- Node runtime bumped to 22 (engines.node `>=22 <23`, `.nvmrc=22`, CI `actions/setup-node@v4`).
- Dependency surface: added `pino@^10`, `split2@^1`, `ink@^7.1.1`, `react@^19.2`, `@types/react@^19.2`, `node-ical`, `@discordjs/voice`, `opusscript`, `ffmpeg-static`. Dev: `pino-pretty@^13`.
- Bot version bumped 0.1.0 → 0.2.0.

### Security

- Fail-closed semantics: any `ConsentService.authorize()` failure (storage corruption, Discord API error) returns deny — never a silent allow.
- Pino redaction paths cover `*.discordToken`, `*.token`, `*.password`.
- State-snapshot bundles encrypted AES-256-GCM with `STATE_SNAPSHOT_ENCRYPTION_KEY`; revoke triggers `applyRetentionPlan` to expire affected snapshots.

## [Unreleased]

### Added

- Slash command foundation: guild-scoped registration via `REST.put(Routes.applicationGuildCommands(...))`, an `InteractionCreate` listener, and minimal examples `/ping` (returns WS ping) and `/help` (lists registered commands). New module at `src/features/slash-commands/` with a `HandlerDependencies`-style DI seam and a `deploy:commands` script (`src/scripts/deploy-commands.ts`).
- Personal reminder feature (`src/features/reminder/`): `/remind me <duration> "message"` slash command schedules a DM with caps at 7 days duration and 10 active reminders per user; scheduler scans every 30s and reloads from `data/reminders.json` on boot (gitignored) with malformed-file tolerance, matching the timekeeper-history pattern.
- Project-local AI agent dispatchers (`CLAUDE.md` / `AGENTS.md`) pointing to a `docs/` knowledge base (architecture, process, recovery, security, quality).
- Dependabot weekly update PRs (`npm` ecosystem, Asia/Tokyo Monday 09:00).
- Lightweight security workflow (`bun audit --production` + CodeQL on push / PR).
- GitHub issue forms (feature / bug) and a pull request template.
- Sprint / release / agile workflow doc with `release-<major>-<minor>-<patch>` branch model and Issue-only ticket branches.
- Birthday auto-role feature: `/birthday set|remove` slash command, JST 0:00 daily scheduler that grants and removes the `@Birthday` role, optional announcement in a configured text channel, and JSON-persisted registry at `data/birthdays.json`.

### Changed

- Default branch renamed `master` → `main`.
- `.env.example` upgraded to a schema reference (real values are now expected to come from the host's secret manager).
- `README.md` and `CONTRIBUTING.md` no longer instruct to copy `.env.example` into a local `.env`.

### Fixed

- `tests/timekeeper-session-clock.test.ts` import sorting + formatting.
- `tests/timekeeper-timeline.test.ts` formatting.

## [0.1.0] — initial integration

First integrated release of the timekeeper + reaction-roles Discord bot.

### Added

- Zod-validated env → `BotConfig` (`src/config.ts`).
- Discord `Client` construction with the required intents (`src/bot/create-discord-client.ts`).
- Reaction-role feature: rule-based add / remove via `MessageReactionAdd` / `MessageReactionRemove` listeners (`src/features/reaction-roles/`).
- Timekeeper feature: 5-phase JST pomodoro, `tmp-audio/` WAV timeline, stage-channel speaker workaround, compressed-minute clock for in-session testing, Wikipedia-powered fortune summary, persisted attendance (`src/features/timekeeper/`).
- Stage-channel audio smoke script (`bun run smoke:stage`).

### Engineering

- TypeScript strict mode, ESM, NodeNext, ESLint, Biome, Knip, Vitest.
- Concurrency-aware CI on every push to `main` and every PR.
