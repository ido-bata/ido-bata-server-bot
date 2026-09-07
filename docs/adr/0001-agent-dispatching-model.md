# ADR-0001 — Agent dispatching & parallel-work model

- Status: Accepted
- Date: 2026-09-07
- Deciders: maintainers (initial integration: 0.1.0)

## Context

This repository was set up so that multiple AI coding agents (Claude Code, Codex, and any local subagent supervisor) can work concurrently without colliding. The risks we are designing against are:

- Edit collisions when two agents touch the same `release-x-y-z` branch.
- Lost work when a session, sandbox, host, or model-provider dies mid-task.
- Inconsistent quality because the project grew without a stack-aware quality gate.
- Long-lived decisions that nobody can reconstruct after the chat that approved them.

The repo is small (one Discord bot, ~10 source files, ~10 test files) and English-speaking. The team uses native agent supervisors rather than a custom one. A custom container-based Supervisor is not justified at the current size; the dispatching model has to work with the native supervisor of whichever agent the user is running.

## Decision

1. **Knowledge base lives in repository-controlled docs**, not in agent-private memory. The root files `CLAUDE.md` and `AGENTS.md` are dispatchers (pointer tables only). All deep content lives under `docs/` (architecture, process, quality, recovery, security) and is read on demand.
2. **One sprint = one target SemVer** on a `release-<major>-<minor>-<patch>` branch cut from `main`. A top-level Issue produces exactly one ticket branch named with the issue number (no prefix, no slug). The first meaningful commit opens a Draft PR into the active release branch. The release branch → `main` PR is the only merge that lands on `main`.
3. **Durable work state lives in GitHub Issues + Projects** (not in supervisor-local DBs). Issue title/body is Japanese; commit messages, source comments, and identifiers are English.
4. **Fresh-agent recovery path is canonical.** A fresh agent can recover the in-flight state by reading `gh issue list` / `gh pr list` / `git fetch --all` / `docs/recovery.md` — without any conversation history, native session ID, or supervisor DB. Soft checkpoints (local immutable ref, sandbox snapshot) are optimisations; the hard-checkpoint boundary is `GitHub Issue + ticket branch tip + docs/`.
5. **Stack-aware quality gate** (not a fixed bundle). The release gate is the union of `lint`, `type-check`, `test`, `build`, `knip`, `biome`, plus `smoke:stage` for voice/stage changes. Coverage thresholds are deliberately not enforced on the current surface.
6. **No custom Agent Supervisor / sandbox runtime at this size.** We adopt the native supervisor of whichever agent the user is running. This decision is revisable in a future ADR if the team grows to need execution fencing, lease-based side-effect reconciliation, or per-ticket generation counters.
7. **No new container definition until needed.** Containerfile (per project policy) will arrive via Issue #27 (`release-0-4-0`). Until then, `bun run dev` and `bun run start` are the day-0 path on host Node + `tsx`.
8. **All Agent Skills are realised as repository docs** rather than as installable skills. The `docs/` directory covers `parallel-orchestration` (process.md), `quality-gate` (quality.md), `security-maintenance` (security.md), `onboarding` (README + CONTRIBUTING), `agent-recovery` (recovery.md), `engineering-decisions` (ADR directory + CLAUDE.md pointer table), `github-delivery` (process.md + release-drafter + PR template), and `sandbox-runtime` (process.md + recovery.md).

## Consequences

- Easier: a fresh agent can resume without conversation history; a new contributor can onboard from README + CONTRIBUTING; a release-drafter-driven release notes flow works out of the box; every long-lived decision has a documented home.
- Harder: the team has to write things down instead of explaining them in chat; root files are short and require agents to follow pointers; release branches must be cut and managed deliberately.
- Constrained: the release-drafter config, the issue templates, the PR template, and the `docs/quality.md` gate are now coupled — changes to one must be reflected in the others.

## Alternatives considered

- **Custom Agent Supervisor + sandbox runtime** — rejected for now; the project surface is too small to justify the maintenance cost. Revisit when two or more long-lived concurrent workers are running on the same sprint.
- **Global / installable Agent Skills** — rejected; the policy says project-local is the default and that skills must justify their source, trust, maintenance, and reproducibility. The `docs/` directory already covers the same ground with zero external trust.
- **Coverage threshold in CI** — rejected; the surface is too small for the signal to beat the noise. Knip + a Vitest run are the lightweight proxy until the source tree grows.
- **Containerise day-1** — rejected; Discord voice on Node + `tsx` is reliable, and the team is on host Bun tooling. Issue #27 will revisit.

## References

- `CLAUDE.md`, `AGENTS.md`
- `docs/process.md` (sprint / branch / release gate)
- `docs/recovery.md` (fresh-agent recovery algorithm)
- `docs/quality.md` (stack-aware quality gate)
- `docs/security.md` (advisory intake + SLA)
- `.github/release-drafter.yml` (release notes categories)
- `.github/ISSUE_TEMPLATE/` (bug / feature templates)
- Related Issues: #27 (Containerfile), #49 (architecture.md Mermaid), #52, #53 (future ADRs)
