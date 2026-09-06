# Contributing

## Local setup

1. Install **Bun 1.3** or later.
2. `bun install` to fetch dependencies (CI uses `--frozen-lockfile`).
3. Provide the required env vars (`DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`, optional `DISCORD_ENABLE_MESSAGE_CONTENT` / `TIMEKEEPER_RUN_ON_READY`). Real secrets are sourced from the host — a CI secret, a vault, exported shell variables, or a git-ignored local `.env`. The `.env.example` documents the schema.
4. `bun run type-check && bun run test` to confirm the baseline is green before you change anything.

The bot itself runs via `tsx` on Node — Bun is only used for installs and scripts.

## Work flow

For durable work items, open a GitHub **Issue** (Japanese title/body) with at least:

- **Objective**
- **Acceptance criteria** (testable)
- **Scope / non-scope**
- **Target version** (the active `release-x-y-z` sprint, or "backlog")
- **Area / component** (e.g. `timekeeper`, `reaction-roles`, `infra`)

Branch off the active release branch as `<issue-number>` (the issue number alone is the branch name — no prefix, no slug, no work-type). Open a **Draft PR** as soon as the first meaningful commit lands; flip to ready when acceptance criteria are met and the integration gate is green.

The release process, including the gate and how to merge into `main`, lives in [`docs/process.md`](./docs/process.md). Project-wide conventions live in [`CLAUDE.md`](./CLAUDE.md) / [`AGENTS.md`](./AGENTS.md). Architecture lives in [`docs/architecture.md`](./docs/architecture.md).

## Coding conventions

- TypeScript strict mode, ESM, NodeNext. Relative imports must keep the `.js` extension.
- Prefer `import type` for type-only imports (enforced by ESLint).
- Run `bun run lint && bun run biome:fix && bun run type-check && bun run test` before pushing.
- Run `bun run knip` if you add or remove files / dependencies.

## Adding a Discord ID or feature config

Do **not** commit real Discord IDs unless they are documented examples. Replace placeholders before testing in the live guild, but keep the source files free of personal data.

## Reporting a vulnerability

See [`SECURITY.md`](./SECURITY.md). Do not open a public Issue for suspected leaks of `DISCORD_TOKEN` or any other secret — rotate first, then coordinate privately.
