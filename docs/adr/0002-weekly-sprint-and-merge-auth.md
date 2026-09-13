# ADR-0002 — Weekly sprint cadence & merge-authorization boundary

- Status: Accepted
- Date: 2026-09-13
- Deciders: maintainers (project re-initialization, post-ADR-0001)
- Supersedes: `docs/process.md` § "Agile cadence" (2 weeks → 1 week)

## Context

ADR-0001 set up the agent-dispatching model and the GitHub workflow but did not commit to a sprint length, and `docs/process.md` initially documented a 2-week cadence ("adjust as the team learns"). Two unaddressed gaps followed:

1. The project-init policy for multi-agent parallel work treats **one week** as the default sprint length and one target SemVer per sprint. A 2-week cadence dilutes the boundary between "scope slipped" and "we shipped", and increases the cost of cutting a partial sprint into a patch release.
2. The release-process doc described what must be true at merge time (green release gate, PR ready) but did not name **who** is allowed to execute a merge. Without that explicit boundary, agents and reviewers drift toward "Ready ⇒ merge" — which is the failure mode the project-init policy explicitly forbids ("対応して" / "最後まで進めて" do not authorize a merge).

We also confirmed during this re-init that the public `main` branch protection on this repo is incomplete (no `enforce_admins`, no `required_linear_history`, no `required_conversation_resolution`, no head-pattern ruleset). The doc gap and the protection gap are coupled: an explicit policy gives the maintainer something concrete to enforce.

## Decision

1. **Sprint length is one week** (Monday start, Friday end-of-day ship). Cadence stays at one week unless a future ADR revises it. `docs/process.md` § "Agile cadence" is updated to state this and to note that hotfixes still go via `release-x-y-z → main`.
2. **Merge authorization is a separate boundary from PR readiness.** An agent may open, push, review, resolve, rebase, re-validate, and mark a PR Ready. An agent may not execute a merge, squash-merge, rebase-merge, native stacked-PR contiguous landing, auto-merge enablement, or equivalent landing side-effect without an explicit user instruction that names the PR (or a clearly bounded PR set) and the merge action. `docs/process.md` § "Merge authorization boundary" codifies this.
3. **Stacked tickets are Done only on trunk landing.** Closing a stacked ticket's Issue after a merge into an intermediate predecessor branch is incorrect. The Issue is closed only after the ticket changes appear on the target release trunk tip. `docs/process.md` § "Stacked ticket — Done boundary" codifies this.
4. **Branch-start contract is mandatory and applies to every agent.** A durable ticket branch is "active" only after the first meaningful commit is published to the canonical remote **and** a Draft PR exists, linked to the Issue, with the right assignee / labels / target-version. `docs/process.md` § "Branch-start contract (mandatory)" codifies this.
5. **Public `main` protection is documented as a required configuration**, and any gap is a blocker. `docs/process.md` § "Public `main` protection" enumerates the minimum required configuration (PR-only, no force-push, ≥1 review, `enforce_admins`, `required_linear_history`, `required_conversation_resolution`, required checks for CI / audit / CodeQL, plus a release-source ruleset).
6. **Recovery.md now describes a structured recovery-checkpoint schema** even though this small bot project doesn't persist one today. It documents the schema so a future worker / Supervisor that wants to checkpoint intermediate state has a concrete shape, and it states explicitly that a branch whose latest commit is not on the canonical remote (or whose PR is not linked to its Issue) is **not** a hard checkpoint.

## Consequences

- Easier: weekly cadence makes "scope slipped → cut as patch" a low-cost reflex; the explicit merge-authorization text gives reviewers a script to invoke when an agent tries to self-merge; the branch-start contract prevents the "local-only commit, no PR, three days of work stranded" failure mode; the recovery schema gives future subagents a concrete shape.
- Harder: the team must write things down rather than absorb them in chat; reviewers must check the public-`main` protection state before cutting the next release branch and flag any gap as a blocker.
- Constrained: process.md, recovery.md, and this ADR are now coupled. Changes to the cadence, merge-auth text, branch-start contract, or recovery schema must be reflected in all three. Future ADRs that touch these must reference or supersede this one.

## Alternatives considered

- **Stay at 2 weeks.** Rejected — the project-init policy treats 1 week as the standard, and a 2-week cadence increases the cost of partial-sprint cuts without buying better planning.
- **Allow agents to merge when the gate is green.** Rejected — this is the failure mode the project-init policy explicitly names, and the current bot has no supervisor-side fencing to undo an accidental merge.
- **Per-ticket merge via closing keywords alone.** Rejected — the project-init policy forbids relying on closing keywords for non-default-branch merges, and stacked tickets in particular need the trunk-landing check.
- **Skip documenting the public `main` protection.** Rejected — the repo is public and the project-init policy explicitly requires the doc / enforcement pair. Documenting the requirement is what lets a future maintainer (or a future agent) flag the gap as a blocker rather than discovering it after the fact.

## References

- `docs/process.md` — Agile cadence, Branch-start contract, Merge authorization boundary, Stacked ticket Done boundary, Release branch Draft release PR, Public `main` protection
- `docs/recovery.md` — Structured recovery checkpoint (schema), Hard-checkpoint boundary
- `ADR-0001` — Agent dispatching & parallel-work model
- GitHub Issues: #56 (リリース駆動アジャイル開発プロセスの導入 — already merged), #57 (process.md update), #49 / #52 / #53 (related ADR work)