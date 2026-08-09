# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

All commands use Bun as the package manager and script runner.

- `bun install` — install dependencies (CI uses `--frozen-lockfile`)
- `bun run dev` — start the bot in watch mode (tsx watch)
- `bun run start` — start the bot once (tsx)
- `bun run lint` — run ESLint (typescript-eslint, rules include `consistent-type-imports`)
- `bun run test` — run all tests once with Vitest
- `bun run build` — type-check and emit to `dist/` (prebuild wipes `dist/`)
- `bun run smoke:stage` — run `src/scripts/stage-audio-smoke.ts` to verify voice playback in a stage channel

Single-test invocation: `bun run test -- tests/timekeeper-timeline.test.ts` or with vitest's filter: `bun run test -- -t "describe phrase"`.

The bot runtime is Node via `tsx`, **not** Bun. This is intentional — Discord voice is more reliable on Node. Bun is only used to install deps and run scripts.

## Environment

Required env vars (see `.env.example`):

- `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID` — validated by Zod in `src/config.ts`
- `DISCORD_ENABLE_MESSAGE_CONTENT=true` — required to enable the privileged Message Content intent (also must be enabled in the Discord Developer Portal)
- `TIMEKEEPER_RUN_ON_READY=true` — runs the timekeeper session immediately on `ClientReady` and compresses in-session minutes to 1 second for testing. Without it, the timekeeper schedules its first session for the next 21:00 JST.

If a bot token leaks, rotate it in the Discord Developer Portal and replace it in `.env`.

## Architecture

Entry point: `src/index.ts` reads config, creates the Discord client, then registers feature handlers. The `Client` is the only shared dependency — each feature registers its own event listeners.

### Layout

- `src/index.ts` — composition root
- `src/config.ts` — Zod-validated env → `BotConfig`
- `src/bot/create-discord-client.ts` — constructs `Client` with intents (`Guilds`, `GuildMessages`, `GuildMessageReactions`, `GuildVoiceStates`; adds `MessageContent` only when enabled)
- `src/features/reaction-roles/` — `config.ts` holds the rule list; `handler.ts` registers `MessageReactionAdd`/`Remove` listeners. Uses a DI seam (`HandlerDependencies`) so the role-lookup and member-fetch logic can be replaced in tests
- `src/features/timekeeper/` — daily pomodoro-style scheduler. Submodules:
  - `config.ts` — JST start time, channel IDs, phase list
  - `schedule.ts` — JST-aware next-start computation
  - `timeline.ts` — builds the event timeline (`work-start-soon`, `phase-start`, `phase-ending-soon`, `break-start`, `session-end`) and the progress-message formatter
  - `service.ts` — orchestrator: schedules, joins voice, plays audio, posts/edits progress messages, records attendance
  - `engagement.ts` — check-in buttons, attendance persistence (`data/timekeeper-history.json`), Wikipedia-powered fortune summary at session end
  - `wikipedia.ts` — fetches a random JA Wikipedia topic with a hardcoded fallback
  - `voice-debug.ts` — structured JSON logging around `@discordjs/voice` (errors only by default; state-change handlers are commented out)
- `src/scripts/stage-audio-smoke.ts` — joins the configured voice channel, plays the first timeline clip, then exits
- `tests/` — vitest specs that mirror `src/` layout (`config.test.ts`, `timekeeper-timeline.test.ts`, `timekeeper-engagement.test.ts`, etc.)

### Timekeeper timeline model

`buildTimekeeperTimeline()` in `src/features/timekeeper/timeline.ts` constructs exactly 12 events for the default 5-phase config. Each event has a numeric `order` (1–12) that maps to a WAV filename in `tmp-audio/`:

- `NNN_<name>.wav` where `NNN` is the zero-padded `order`
- Files are listed via `readdirSync` and matched by the leading 3-digit prefix
- Missing audio files throw at session start

Adding/reordering phases requires updating both `timekeeperConfig.phases` and the 12-event list in `buildTimekeeperTimeline` (it indexes `phases[0..4]` directly — extending beyond 5 phases requires editing that function).

### Timekeeper stage-channel quirks

Stage channels (`ChannelType.GuildStageVoice`) need extra handling in `service.ts`:

1. `prepareStageSpeaker` unsuppresses the bot (or requests to speak if unsuppress fails)
2. `connectForPlayback` destroys the connection and reconnects after suppression, because audio relay often fails on the first join
3. `refreshStageSpeakerBeforePlayback` re-unsuppresses before every clip

If you change voice behavior, leave these workarounds in place until you confirm the underlying `@discordjs/voice` issue is resolved.

### Timekeeper session clock

`createSessionClock` (in `service.ts`) drives two time scales:

- **wall-clock mode**: scheduled sessions — delays match real time
- **mid-session resume / `TIMEKEEPER_RUN_ON_READY=true`**: minute durations are compressed to 1 second so the whole session runs in ~minutes instead of ~100 minutes

`getDelayFor` switches between these modes. Any new time-based behavior should respect `clock.minuteMs` rather than hardcoding `60_000`.

### Engagement state

`activeSession` and `activeTimeline` are module-level singletons in `service.ts`. They back the check-in button handler and the fortune summary. They reset to `null`/`[]` at session end. Be careful with concurrent sessions — only one can be active at a time.

### Reaction roles

Rules live in `src/features/reaction-roles/config.ts`. Each rule is `{ messageId, emoji, roleId }` — placeholder IDs must be replaced with real Discord IDs before the feature does anything. `toEmojiKey` resolves a custom emoji by ID or falls back to its unicode name.

The handler factory `createReactionRoleHandler(deps)` accepts `findRule` and `withMemberRoleManager` overrides; tests use these instead of touching the Discord API.

### Tests

Tests live in `tests/` and import from `../src/...js` (NodeNext `.js` extensions). `vitest/globals` types are enabled in `tsconfig.json`, so `describe`/`it`/`expect` are available without imports. Run a single file or filter with `bun run test -- <pattern>`.

CI (`.github/workflows/ci.yml`) runs `bun install --frozen-lockfile`, lint, test, and build on every push to `master` and on PRs.

## Conventions

- TypeScript strict mode, ESM (`"type": "module"`), NodeNext modules — use `.js` extensions in relative imports
- Prefer `import type` for type-only imports (enforced by ESLint)
- Don't leave placeholder Discord IDs in feature configs in committed code beyond the documented examples
- `data/timekeeper-history.json` is gitignored — it's local persisted state, not source