# Release & contribution process

How durable work flows through this repo. Maintained in repo-controlled docs (this file) — not in chat memory.

## Agile cadence

- **Sprint length**: 2 weeks (Monday start, Friday end-of-day ship — adjust as the team learns).
- **Sprint = one target SemVer**. The sprint board lives in a GitHub Project; the target version field carries the active `release-<major>-<minor>-<patch>`.
- **Release-bound**: every merge into `main` is gated by the release gate below. We do not merge a partial sprint. If scope slips, cut the sprint short and re-cut it as a patch release rather than slipping the boundary.
- **Demo / retro**: end of sprint. Issues for the next sprint are triaged on Monday morning and assigned a `Target version`.
- **Hotfixes**: a critical, exposed, dependency-level vulnerability (see [`docs/security.md`](./security.md)) or a confirmed production outage can interrupt the current sprint with a patch release.

## Active sprint

| Version | Start date | Target release date | Status |
| ------- | ---------- | ------------------- | ------ |
| `release-0-1-0` | 2026-09-07 | 2026-09-14 | In Progress |

### Included Issues

- #51: `bun audit --production` を required check 化
- #54: 依存関係の更新とセキュリティパッチ適用
- #55: timekeeper ステージ接続の安定性改善
- #56: リリース駆動アジャイル開発プロセスの導入

## SemVer policy

This repo follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html):

| Bump    | Trigger                                                                                                | Label      |
| ------- | ------------------------------------------------------------------------------------------------------- | ---------- |
| major   | Any breaking change to a Discord-side contract (event payload, command interface, exported schema)      | `breaking` |
| minor   | New feature, opt-in behavior, additive API                                                              | `feature`  |
| patch   | Bug fix, dependency patch, security fix, internal refactor                                              | `bug` / `deps` / `security` |

Labels feed [`.github/release-drafter.yml`](../../.github/release-drafter.yml) (driven by `.github/workflows/release-drafter.yml`) so the draft release notes are deterministic per PR.

The current source-of-truth version is the `version` field in [`package.json`](../../package.json). Changes to that field happen **only** in the release PR (`release-x-y-z` → `main`).

## Branches

```text
main                                # released / integrated source state
└─ release-<major>-<minor>-<patch>  # active sprint integration target
   ├─ <issue-number>                # one ticket branch per top-level Issue
   ├─ <issue-number>
   └─ <issue-number>
```

Rules:

- **Never commit directly to `main`.** Open a PR from a release or ticket branch.
- A sprint is **one target semantic version**. Start of sprint cuts `release-x-y-z` from `main`.
- A ticket branch uses **only the issue number** as its name (no `issue/`, no slug, no work-type prefix). The `Issue` body and the PR description carry all context.

## Issues (work state)

Independent, plan-able, implementable, reviewable units become GitHub Issues (Japanese title/body). The board lives in GitHub Projects (Kanban: `Backlog` → `Ready` → `In Progress` → `In Review` → `Done`). Recommended fields:

- Priority / Size / Target Version
- Area / Component
- Blocked / dependency

Short-lived nested subtasks can stay as Supervisor task entries — do not promote them to Issues unless they outlive a single agent session.

## PRs

- Title and body in **Japanese**; commit messages and source comments in English.
- Open a **Draft PR** as soon as a ticket has meaningful work; flip to **Ready for review** when acceptance criteria are implemented and the ticket integration gate is green.
- Squash-merge per ticket into the release branch. The release PR (release branch → `main`) is the only merge that lands on `main`.

## Release gate

Before merging `release-x-y-z → main`, run the full applicable validation:

- `bun install --frozen-lockfile`
- `bun run lint`
- `bun run type-check`
- `bun run test`
- `bun run build`
- `bun run knip`
- `bun run smoke:stage` (if release touches voice / stage behavior)

A partial pass is **not** a pass. Re-run the full gate after any rebase that landed during review.

## Bot token

If a Discord bot token is ever pasted into chat, logs, a commit, an agent result, or a checkpoint: **rotate it in the Discord Developer Portal and replace it in `.env`**. Do not rely on git history rewriting to "remove" a leaked secret.
