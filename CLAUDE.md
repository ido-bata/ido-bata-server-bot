# CLAUDE.md

This file is the dispatcher for Claude Code (claude.ai/code) when working on `ido-bata-server-bot`. Read it before any task. Load other docs from `docs/` only when you need them — do not re-load this meta-prompt or the full project-init document.

## Project identity

- Discord server bot. TypeScript ESM, strict mode, NodeNext modules.
- Package manager / script runner: **Bun**. Bot runtime: **Node via `tsx`** (Discord voice is more reliable on Node).
- Released source state: `main`. Active sprint integration: `release-<major>-<minor>-<patch>`. Ticket branch: `<issue-number>`.

## Pointer table

| If you need to…                                | Read                                       |
| ---------------------------------------------- | ------------------------------------------ |
| Run a command / understand scripts             | `package.json` + this file (Commands below) |
| Know the runtime / config / intent layout      | `docs/architecture.md`                     |
| Plan a release, branch, Issue, or PR           | `docs/process.md`                          |
| Recover in-flight work from a fresh agent      | `docs/recovery.md`                         |
| React to a dependency advisory / secret leak   | `docs/security.md`                         |
| Decide what verification to run                | `docs/quality.md`                          |
| Onboarding for a new contributor               | `README.md`, `CONTRIBUTING.md`             |
| Document an architectural / process decision   | `docs/adr/` (read newest first)            |

## Commands

- `bun install` — install deps (CI uses `--frozen-lockfile`)
- `bun run dev` — start the bot in watch mode (`tsx watch`)
- `bun run start` — start the bot once (`tsx`)
- `bun run lint` — ESLint (typescript-eslint, enforces `consistent-type-imports`)
- `bun run biome` / `biome:fix` — Biome (formatter + linter, configured by `biome.json`)
- `bun run type-check` — `tsc --noEmit`
- `bun run knip` — unused files / dependencies / exports (`knip.json`)
- `bun run test` — Vitest once
- `bun run build` — type-check + emit to `dist/` (`prebuild` wipes `dist/`)
- `bun run smoke:stage` — `src/scripts/stage-audio-smoke.ts` to verify voice playback in a stage channel

Single-test invocation: `bun run test -- tests/timekeeper-timeline.test.ts` or `bun run test -- -t "describe phrase"`.

## Environment

Required env vars (see `.env.example`):

- `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID` — Zod-validated in `src/config.ts`.
- `DISCORD_ENABLE_MESSAGE_CONTENT=true` — privileged Message Content intent (also enable in the Discord Developer Portal).
- `TIMEKEEPER_RUN_ON_READY=true` — runs the timekeeper session immediately on `ClientReady` and compresses in-session minutes to 1 second for testing. Without it, the timekeeper schedules the first session for the next 21:00 JST.

If a bot token leaks, rotate it in the Discord Developer Portal and replace it in `.env`. See `docs/security.md`.

## Conventions

- TypeScript strict mode, ESM (`"type": "module"`), NodeNext — use `.js` extensions in relative imports.
- Prefer `import type` for type-only imports (enforced by ESLint).
- Do not leave placeholder Discord IDs in feature configs in committed code beyond the documented examples.
- `data/timekeeper-history.json` is gitignored — it's local persisted state, not source.
- Commit messages and source comments in English; Issue titles/bodies and PR titles/descriptions in Japanese.
- Never paste `DISCORD_TOKEN` or any other secret into a commit, an Issue body, a PR description, a CI log, a checkpoint, or an agent result.

## Verification entry point

`docs/quality.md` lists what each validation level covers and which suite covers it. For a normal ticket, the minimum gate is `bun run lint && bun run type-check && bun run test`. For voice/stage changes, also run `bun run smoke:stage`.
