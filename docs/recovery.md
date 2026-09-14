# Agent recovery policy

How a fresh AI agent recovers this project's in-flight work **without** depending on conversation history, native session resume, or supervisor-local state.

## Sources of truth (priority order)

1. GitHub Issues / Projects / PRs / branch graph (durable work state)
2. `main` (released) and `release-x-y-z` (active sprint integration)
3. Ticket branch + commit graph
4. CI / required-check state on the PR
5. This `docs/` directory and `CLAUDE.md` / `AGENTS.md`
6. Local persisted state on disk (e.g. `data/timekeeper-history.json`) — read but never assume it's authoritative for *intent*

Conversation transcripts, native session IDs, supervisor-local DBs, and shell history are **transient optimizations**. They may be reused when available but never the canonical recovery path.

## Failure model the recovery path covers

- Model / session context loss mid-task
- Agent process crash or cancellation
- Sandbox / container / VM recreation
- Parent agent crash while a child runs
- Host reboot, network blip, provider TTL expiry
- GitHub Actions / dependabot / hook outage

## Recovery algorithm for a fresh agent

1. `gh issue list` / `gh pr list` to identify open Issues, target release, in-flight PRs.
2. `git fetch --all` and inspect the active `release-x-y-z` branch and any `<issue-number>` branches ahead of it.
3. Read the relevant Issue body and the PR description — they carry acceptance criteria, scope, blockers, and target version.
4. Reconstruct the workspace at the PR's tip commit and verify `bun install --frozen-lockfile` + `bun run type-check` succeed before touching anything.
5. Cross-check `docs/process.md`, `docs/architecture.md`, and `docs/security.md` for any policy that supersedes what's in the Issue.
6. If a previous child agent produced an artifact, treat it as immutable: re-derive the diff against the current PR tip before integrating.

## What "checkpoint" means here

This project does **not** push every micro-edit to a remote branch. We checkpoint at meaningful boundaries:

- First compilable cut of a ticket
- Every change to the timekeeper timeline shape
- Every change that crosses a Discord intent boundary
- Every external side-effect (Discord message sent, audio played)
- Before context-window handoff or a `longjmp`-style suspension

Boundary commits go on the **ticket branch**, named for the issue. Squash-merge into the release branch only after the ticket integration gate is green.

A durable ticket branch is only "active" once it carries **both**:

- A published remote head (`origin/<issue-number>` resolves to the local tip).
- An immediate Draft PR linked to the Issue.

If either is missing, the recovery algorithm treats the branch as not properly started and restarts from the branch-start contract in `docs/process.md`.

## Structured recovery checkpoint (schema)

For subagents / workers that produce intermediate artifacts, the recoverable state is captured as an immutable checkpoint with this schema. Secrets, machine-specific absolute paths, and private reasoning are **never** persisted.

```text
schema_version
issue_id
target_release
ticket_branch
pr_number
immediate_pr_base           # release-x-y-z | <predecessor-issue>
predecessor_issue_or_pr    # issue/PR id, or null if independent
predecessor_sha            # pinned predecessor head SHA, or null
base_sha                   # PR base SHA at checkpoint time
checkpoint_sha_or_snapshot # commit SHA or filesystem snapshot id
execution_generation       # monotonic; rejects stale generations
status                     # open | in_progress | blocked | integrated | aborted
completed_steps
next_steps
pending_validation
active_children
integrated_child_results
external_side_effects      # Discord message ids, audio playback ids, etc.
blockers
decision_refs              # ADR ids, Issue links, doc anchors
artifact_refs              # paths under .tmp/ or .reference/ (never secrets)
updated_at
```

### Soft vs hard checkpoint

- **Soft checkpoint** (same host / sandbox recovery): local immutable refs, filesystem snapshots, Supervisor journal. Used for fast resume within the same host.
- **Hard checkpoint** (host, sandbox, or provider lost): the durable recovery boundary is `GitHub Issue + ticket branch tip + this docs/ tree + the published Draft PR`. Anything not represented there is presumed lost.

A branch whose latest commit is **not** on the canonical remote is not a hard checkpoint. A PR that is **not** linked to its Issue is not a hard checkpoint. Validate both before trusting the durable state.

## Hard-checkpoint boundary

If the host, sandbox, or model-provider is lost, the recovery boundary is the **GitHub Issue + the ticket branch tip + `docs/`**. Everything needed to resume lies in those durable stores.
