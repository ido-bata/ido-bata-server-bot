# Security

## Reporting a vulnerability

If you find a security issue in this bot or suspect a leaked secret (`DISCORD_TOKEN` etc.):

1. **Do not** open a public GitHub Issue.
2. Rotate the affected secret in the Discord Developer Portal **first** if it has already leaked.
3. Then contact the maintainers privately through the standard GitHub private-vulnerability-report flow on this repository.

The full intake and triage workflow (sources, reachability, SLA) is documented in [`docs/security.md`](./docs/security.md).

## Supported versions

Only the latest commit on `main` is supported. Older release tags and the active sprint branch (`release-x-y-z`) receive security fixes via the regular sprint flow.

## Dependency advisories

Dependabot is enabled (`.github/dependabot.yml`). A meaningful advisory — severity × reachability — is converted into a GitHub Issue, assigned a target version, and tracked on the project board. Critical, exposed, dependency-level vulnerabilities can interrupt the current sprint in favor of a patch release.
