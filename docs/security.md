# Security & dependency intake

How this project tracks and responds to security-advisory information for the dependencies it actually uses.

## Source priority

1. Official framework / runtime / SDK security advisory (`discord.js`, `@discordjs/voice`, `zod`, Node.js release notes, Bun release notes).
2. GitHub Security Advisories for the dependency.
3. GitHub `dependabot` alerts raised against this repo.
4. Maintainer patch releases (semver-diff-driven review).
5. Trusted secondary sources (Snyk, OSS Index) only when (1)–(4) are silent.

## In-repo intake

- Dependabot is enabled (`.github/dependabot.yml`) for `npm` (the lockfile is maintained by Bun but `npm` ecosystem is the closest signal). Grouped patch updates; non-patch updates open their own PR.
- A meaningful advisory (severity + reachability) is converted to a GitHub Issue with the `security` label, a `Target Version`, and an `Acceptance criteria` section.
- A critical, exposed, dependency-level vulnerability can interrupt the current sprint in favor of a patch release on `release-x-y-z` → `main`.

## Reachability check before patching

Before bumping a dependency, confirm whether the vulnerable code path is actually invoked by this bot. `timekeeper`, `reaction-roles`, and `bot` are the only entry points — anything outside those is presumed non-reachable until proven otherwise.

## Secrets handling

- **Never** put `DISCORD_TOKEN` (or any other secret) into a commit, an Issue body, a PR description, a CI log, a Supervisor checkpoint, an agent result, or a chat transcript.
- If a leak is suspected: rotate the token in the Discord Developer Portal **first**, then update the local `.env`.
- Secrets are loaded only at startup from environment variables (`dotenv/config`); no secret ever lives in this repo.

## Triage SLA

| Severity (per source) | Reachability unknown       | Reachability confirmed                              |
| --------------------- | -------------------------- | --------------------------------------------------- |
| Critical              | Investigate within 24 h    | Patch sprint within 48 h                            |
| High                  | Investigate within 1 week | Patch in next regular sprint                        |
| Moderate / Low        | Batch into monthly review  | Batch into the next dependency-update window        |
