# Release & contribution process

How durable work flows through this repo. Maintained in repo-controlled docs (this file) — not in chat memory.

## Agile cadence

- **Sprint length**: 1 week (Monday start, Friday end-of-day ship). Cadence stays at one week unless an explicit ADR revises it.
- **Sprint = one target SemVer**. The sprint board lives in a GitHub Project; the target version field carries the active `release-<major>-<minor>-<patch>`.
- **Release-bound**: every merge into `main` is gated by the release gate below. We do not merge a partial sprint. If scope slips, cut the sprint short and re-cut it as a patch release rather than slipping the boundary.
- **Demo / retro**: end of sprint (Friday). Issues for the next sprint are triaged on Monday morning and assigned a `Target version`.
- **Hotfixes**: a critical, exposed, dependency-level vulnerability (see [`docs/security.md`](./security.md)) or a confirmed production outage can interrupt the current sprint with a patch release (still via a `release-x-y-z` → `main` PR — `main` is never edited directly).

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

### Branch-start contract (mandatory)

An active durable ticket branch must always carry both:

1. A **published remote head** — the branch is pushed to the canonical remote and `origin/<issue-number>` resolves to a non-empty tip.
2. An **immediate Draft PR** — opened in the same flow, never "after the work is done."

Procedure:

1. Create the branch from the active `release-x-y-z`.
2. Land the first meaningful commit.
3. Push to the canonical remote. Verify `git rev-parse origin/<issue-number>` equals the local tip.
4. Open a Draft PR immediately, linked to the Issue, with the right assignee / labels / target-version metadata.
5. Only then continue implementation.

Human, Coordinator, implementation worker, and subagent are all subject to this rule. A worker without remote-publication or PR-mutation permission pushes its first commit locally, then hands off to the Coordinator and waits; it does not continue implementation until the Draft PR exists.

### Merge authorization boundary

Quality/readiness is one thing; merge authority is another. An agent (Coordinator, worker, subagent, or Supervisor) **may**:

- Open, push to, and update Draft / Ready PRs
- Respond to review, resolve conflicts, rebase, re-validate
- Mark a PR ready when the integration gate is green

An agent **may not** execute any of these without an explicit user authorization naming the target PR (or a clearly bounded set):

- Merge / squash-merge / rebase-merge
- Native stacked-PR contiguous landing or equivalent
- Auto-merge enablement
- Any landing side-effect that mutates the integration target

Repository policy, Issue/PR metadata, green CI, resolved review, approval, mergeable state, and a successful release gate are not authorization. "対応して", "レビューして", "コンフリクトを解消して", "リリース準備して", "最後まで進めて" are not authorization. "この PR をマージして" or "問題がなければ #123 をマージして" — naming the PR and the merge action — is.

Authorization is scoped to the PR (or set) named in the request. After landing-ready fixups or rebases change the head SHA, re-run the gate against the current SHA before reusing an old authorization. If base, target release, scope, or included changes move materially, do not reuse the old authorization — re-confirm.

Stacked tickets are not Done on a merge into an intermediate predecessor branch; Done only when the ticket changes land on the target release trunk (see below).

### Stacked ticket — Done boundary

A stacked ticket branch (`A → B → C → release-x-y-z`) is not closed by `B → A` or `C → B`. The Issue is closed only after:

1. Every required CI / required-check on the **current** landing candidate is green.
2. Blocking review comments on the ticket's PR are resolved.
3. The ticket changes land on the target release trunk (`release-x-y-z`) — i.e. the `release-x-y-z` tip contains the ticket's commits.

Closing keywords in a non-default-branch merge are not enough on their own. Project status moves to `Done` only after the trunk landing is verified.

## Release branch — Draft release PR

A `release-x-y-z` branch is **zero-diff** with `main` while it has no integrated difference; in that state it does not need a Draft release PR. The moment a ticket (or a meta change) introduces a meaningful integrated difference on the release branch, a **Draft release PR** must exist against `main`. The release PR is the only merge path to `main`.

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

## Public `main` protection

This repository is **public**. Direct edits, direct pushes, force pushes, and branch deletion on `main` are prohibited in normal operation. The only path into `main` is a `release-x-y-z → main` PR that satisfies the release gate above.

Minimum required configuration on `main`:

- Pull requests required (no direct push)
- No force pushes, no deletions
- At least one approving review
- Required checks: `verify` (CI workflow), `audit` (Bun audit), `codeql` (CodeQL)
- `enforce_admins = enabled` — admins do not bypass in normal ops
- `required_linear_history = enabled` — release PR uses squash-merge or rebase-merge
- `required_conversation_resolution = enabled`

When branch protection alone cannot restrict the head branch pattern, a **repository ruleset** enforces `head_ref =~ ^refs/heads/release-[0-9]+-[0-9]+-[0-9]+$` on PRs whose base is `main`. The ruleset is the second line of defence, not a replacement for branch protection.

Any deviation (lacking admin permission, missing required check, etc.) is a **blocker** and must be reported to the user before durable work begins on the next sprint.

## Bot token

If a Discord bot token is ever pasted into chat, logs, a commit, an agent result, or a checkpoint: **rotate it in the Discord Developer Portal and replace it in `.env`**. Do not rely on git history rewriting to "remove" a leaked secret.
