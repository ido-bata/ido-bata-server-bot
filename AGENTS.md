# AGENTS.md

This file is the dispatcher for AI coding agents (Claude Code, Codex, OpenCode, or any local subagent supervisor) when working on `ido-bata-server-bot`. It is read every session — keep it short, route details to Skills / docs. Do not paste the full project-init initialization prompt here.

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
| Decide implementation/design choices yourself  | `.agents/skills/engineering-decisions`     |
| Refine a non-obvious feature before implementing | `.agents/skills/design-refinement`       |
| Write Issues / PRs / branches / merge flow     | `.agents/skills/github-delivery` + `docs/process.md` |
| Write anything that persists (README, ADR, Issue, PR, commit) | `.agents/skills/writing-discipline` |
| Resume after an interruption                   | `.agents/skills/agent-recovery` or `docs/recovery.md` |
| React to a vulnerability / audit a change      | `.agents/skills/security-maintenance` / `security-audit` + `docs/security.md` |

## Skill routing

All skills are project-local in `.agents/skills/` (Claude Code mirror: `.claude/skills/`), tracked with their hashes in `skills-lock.json`. Update via `mise run skills-update`; see "Agent Skills lifecycle" below.

| Capability                                        | Owner skill                          | When |
| ------------------------------------------------- | ------------------------------------ | ---- |
| Implementation decisions / when to ask the user   | `engineering-decisions`              | every implementation or design decision |
| Pre-implementation refinement of non-obvious design | `design-refinement`                | non-obvious feature / architecture work |
| Issue / ticket branch / PR lifecycle / merge auth | `github-delivery`                    | all durable work |
| Release estimation, capacity planning             | `agent-delivery-estimation`          | roadmap / multi-ticket planning |
| Quality gates, verification levels, CI            | `quality-gate`                       | deciding what to validate |
| Minimal sufficient guarantees for invariants      | `correctness-assurance`              | important invariants |
| Vuln intake / proactive security audit            | `security-maintenance` / `security-audit` | advisories / new surfaces |
| Interrupted work recovery, fencing, side effects  | `agent-recovery`                     | fresh agents, interrupted sessions |
| Naming symbols, files, directories                | `code-naming`                        | new names, renames, reviews |
| Skill selection during re-init                    | `skill-selection`                    | re-running this initialization |
| Docs set up for fresh contributors                | `onboarding`                         | onboarding doc changes |
| Evaluate policy / context budget                  | `policy-evaluation`                  | Constitution / practice reviews |
| Genuine out-of-the-box ideation                   | `idea-discovery`                     | "not an extension of existing ideas" |
| Parallel workers / delegation                     | `parallel-orchestration`             | fanning work out to subagents |
| Sandbox runtimes for workers                      | `sandbox-runtime`                    | Worker runtimes, host differences |
| Worktree lifecycle                                | `worktree-workflow`                  | making/removing worktrees |
| Operator interaction: questions, blockers              | `interaction-discipline`             | user/operator-facing sessions |

Not part of the current practice (installed but self-gating): `linear-release-control`, `herdr-runtime`, `orca-frontend` (also `secrets-management` until Infisical migration). Only adopt them alongside the actual tool adoption.

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

Secret SoT for this project is the local `.env` (plaintext, gitignored). The organization profile default (Infisical at `secrets.rebuildup.dev`) is **not** adopted yet — treat that as a deferred migration; do not introduce Infisical tooling into CI/runtime until it is. If migrating, follow `.agents/skills/secrets-management`.

## Worktrees

Worker worktrees are everyday practice here. Creation/removal hooks are repository-controlled: install into a fresh worktree with `mise run worktree:setup` (wired from `.config/wt.toml` for Worktrunk). There is no teardown state to clean (no shared mutable runtime; gitignored `data/*.json` and `dist/` are already worktree-local). Details: `.agents/skills/worktree-workflow`.

## House rules

- Source code (identifiers, comments, developer-facing logs) and commit messages are English; internal documentation, Issues, PRs, and review discussion are Japanese. Localization resources are exceptions.
- Commit messages use `<work-prefix>: <very short title>` (e.g. `feat:`, `chore:`, `fix:`, `docs:`).
- JavaScript / TypeScript package manager is Bun; deviate only for a concrete incompatibility. New scripts are TypeScript (or shell if the tool cannot accept TS); never add new `.py` scripts.
- Text search uses `rg` / `rg --files`.
- New container definitions go in a `Containerfile`.
- Keep project rules in this repository; do not park them in your global config, home directory, or private agent memory.

## Conventions

- TypeScript strict mode, ESM (`"type": "module"`), NodeNext — use `.js` extensions in relative imports.
- Prefer `import type` for type-only imports (enforced by ESLint).
- Do not leave placeholder Discord IDs in feature configs in committed code beyond the documented examples.
- `data/timekeeper-history.json` is gitignored — it's local persisted state, not source.
- Commit messages and source comments in English; Issue titles/bodies and PR titles/descriptions in Japanese.
- Never paste `DISCORD_TOKEN` or any other secret into a commit, an Issue body, a PR description, a CI log, a checkpoint, or an agent result.

## Verification entry point

`docs/quality.md` lists what each validation level covers and which suite covers it. For a normal ticket, the minimum gate is `bun run lint && bun run type-check && bun run test`. For voice/stage changes, also run `bun run smoke:stage`.

## Recovery entry point

If you are a fresh agent with no prior conversation, see `docs/recovery.md` for the canonical sources of truth and the recovery algorithm.


## Constitution / operating profile

- 最上位 contract: [`constitution/CONSTITUTION.md`](constitution/CONSTITUTION.md)
- current Operating Model: [`organization/profiles/release-driven-solo.md`](organization/profiles/release-driven-solo.md)
- repository-specific architecture / runtime / release docs は、Constitution を満たす限り generic upstream Practice より具体的な authority として維持する。


## Agent Skills lifecycle

Skills 本体は **この repository に project-local で commit** する（`.agents/skills/` が universal 入口、`.claude/skills/` は Claude Code 用 mirror）。global install は canonical にしない。実際に使わない tool 専用 Skill（Linear / Herdr / Orca 系）は導入していても practice ではない。

sources:

- `rebuildup/project-init --skill '*'` — コア・スキル群（v0.6.0 期: 22 skills、floating 追跡）
- `rebuildup/writing-skills --skill writing-discipline` — 残す文章の discipline

操作:

- 初回導入 / 全体 reconcile: `mise run skills-bootstrap`
- fresh clone からの lock 復元（`.agents/skills/` のみ）: `bunx skills install`
- 継続更新: `mise run skills-update`（= `bunx skills update -p -y`）
- `skills-lock.json` は `skills` CLI が生成・更新する source/freshness metadata として commit する。手で hash / source entry を捏造しない。
- upstream-managed Skill 本文は手編集しない。project 固有の refinement / override は別の project-local Skill、adapter、ADR、docs に置き、次回 update で上書きされない構造にする。
- update 後は Git diff と applicable quality gate を確認し、upstream 更新を無条件に current project policy とみなさない。

Bun はここでは Agent Skills 管理用の project tooling であり、product runtime / package manager の既存 decision を自動的に置換しない。
