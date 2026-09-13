# Changelog

All notable changes to this project are documented here. Versions follow [Semantic Versioning](https://semver.org/) — see [`docs/process.md`](./docs/process.md) for the release-bound cadence.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses the following categories:

- **Added** — new features
- **Changed** — changes to existing functionality
- **Deprecated** — soon-to-be removed features
- **Removed** — now-removed features
- **Fixed** — bug fixes
- **Security** — vulnerability fixes

## [Unreleased]

### Added

- Project-local AI agent dispatchers (`CLAUDE.md` / `AGENTS.md`) pointing to a `docs/` knowledge base (architecture, process, recovery, security, quality).
- Dependabot weekly update PRs (`npm` ecosystem, Asia/Tokyo Monday 09:00).
- Lightweight security workflow (`bun audit --production` + CodeQL on push / PR).
- GitHub issue forms (feature / bug) and a pull request template.
- Sprint / release / agile workflow doc with `release-<major>-<minor>-<patch>` branch model and Issue-only ticket branches.
- ADR-0002: weekly sprint cadence (1 week) and explicit merge-authorization boundary. Structured recovery-checkpoint schema documented in `docs/recovery.md`. Branch-start contract (mandatory remote-head + immediate Draft PR) and stacked-ticket Done-on-trunk-landing rules added to `docs/process.md`.

### Changed

- Default branch renamed `master` → `main`.
- `.env.example` upgraded to a schema reference (real values are now expected to come from the host's secret manager).
- `README.md` and `CONTRIBUTING.md` no longer instruct to copy `.env.example` into a local `.env`.
- Sprint cadence moved from "2 weeks, adjust as the team learns" to **1 week** (Monday start, Friday end-of-day ship) per the multi-agent project-init policy. Hotfixes still go via `release-x-y-z → main`.
- `docs/process.md` now distinguishes PR readiness from merge authorization: agents may open / update / rebase / re-validate, but may not merge, squash-merge, rebase-merge, enable auto-merge, or execute native stacked-PR landing without an explicit user instruction naming the PR (or a clearly bounded PR set) and the merge action.
- `docs/process.md` now codifies that a stacked ticket is Done only after its changes land on the target release trunk, and that a release branch with a meaningful integrated difference against `main` must carry a Draft release PR.
- `docs/process.md` now documents the public-`main` protection baseline (PR-only, no force-push, ≥1 review, `enforce_admins`, `required_linear_history`, `required_conversation_resolution`, required CI / audit / CodeQL checks, plus a release-source ruleset) and treats any gap as a blocker.
- `biome.json` schema URL bumped from `2.5.7` to `2.5.12` to match the installed Biome CLI.

### Fixed

- `tests/timekeeper-session-clock.test.ts` import sorting + formatting.
- `tests/timekeeper-timeline.test.ts` formatting.

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
