# Changelog

All notable changes to this project are documented here. Versions follow [Semantic Versioning](https://semver.org/) — see [`docs/process.md`](./docs/process.md) for the release-bound cadence.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses the following categories:

- **Added** — new features
- **Changed** — changes to existing functionality
- **Deprecated** — soon-to-be removed features
- **Removed** — now-removed features
- **Fixed** — bug fixes
- **Security** — vulnerability fixes

## [0.2.0] — 2026-09-21

### Added

- **Structured logger + TUI log sink (#8)**: pino-based root logger with bounded ring buffer, in-process subscriber seam for downstream consumers. `LOG_LEVEL` and `LOG_RING_SIZE` env vars. Pino redact paths for tokens/passwords. New `src/lib/logger/` module; all `src/` console.* replaced.
- **Consent Registry (#93)**: Discord-reaction-driven opt-in. `ConsentService.authorize()` is the SoT for authorization; reaction handler wires Discord `MessageReactionAdd` / `MessageReactionRemove` to grant/revoke; reconciler runs on `ClientReady`. Atomic JSON repository at `data/consent.json` (gitignored). Four scopes: `activity-history`, `presence-history`, `profile`, `message-history`.
- **Consent message bootstrap (#102)**: `CONSENT_CHANNEL_ID` alone enables the consent UI. On ready, the bot reuses its own managed consent message or posts one automatically, keeps the template/policy current, adds the configured scope reactions itself, and reconciles against real Discord reaction users. `CONSENT_MESSAGE_ID` remains an optional override.
- **Privacy integration (#94)**: every user-keyed persistent consumer gated through `ConsentService.authorize()`. `/privacy status` (ephemeral: active/revoked scope breakdown + per-consumer storage categories) and `/privacy delete` (cascade delete with partial-fail = failure semantics). `applyDefaultMemberPermissions` wired into slash deploy so `slashPermissionRules` actually reach Discord. `applyRetentionPlan` triggered on revoke for state-snapshot. Timekeeper in-session check-ins remain non-consent (memory only); persistence gated.
- **Runtime TUI dashboard (#95)**: Ink 7 + React 19.2 dashboard with 7 panels (header, discord, features, consent, timekeeper, runtime, events). `BOT_TUI=auto|on|off` env gate; `auto` follows TTY detection. `RuntimeStatusStore` is the read model; subscribers get frozen snapshots. Pino subscriber feeds the events ring buffer. Ctrl+C forwarded to existing shutdown handler. Non-TTY falls back to JSON Lines via pino.
- **ADR templates**: docs/adr/0000 (template), 0001 (agent dispatching model), 0002 (weekly sprint + merge auth boundary) — carried over from `main`.
- **Operational persistent features** (carried from prior work, never landed on main until now):
  multi-guild (per-guild config + listener registry), GitHub Webhook receiver (release / PR / issues → Discord embed), iCal calendar ingest + `/calendar list`, game-activity whitelist, Spotify now-playing embed, member-audit, message-audit, role-slash with audit forwarding, starboard, scheduled-announcements, slash-permissions (deploy wire-up), config-hot-reload, welcome messages, state-snapshot (AES-256-GCM bundles), health-metrics (Prometheus-format).

### Changed

- Node runtime bumped to 22 (engines.node `>=22 <23`, `.nvmrc=22`, CI `actions/setup-node@v4`).
- Dependency surface: added `pino@^10`, `split2@^1`, `ink@^7.1.1`, `react@^19.2`, `@types/react@^19.2`, `node-ical`, `@discordjs/voice`, `opusscript`, `ffmpeg-static`. Dev: `pino-pretty@^13`.
- Bot version bumped 0.1.0 → 0.2.0.

### Security

- Fail-closed semantics: any `ConsentService.authorize()` failure (storage corruption, Discord API error) returns deny — never a silent allow.
- Pino redaction paths cover `*.discordToken`, `*.token`, `*.password`.
- State-snapshot bundles encrypted AES-256-GCM with `STATE_SNAPSHOT_ENCRYPTION_KEY`; revoke triggers `applyRetentionPlan` to expire affected snapshots.

## [0.2.1] — 2026-09-22

### Added

- Slash command foundation: guild-scoped registration via `REST.put(Routes.applicationGuildCommands(...))`, an `InteractionCreate` listener, and minimal examples `/ping` (returns WS ping) and `/help` (lists registered commands). New module at `src/features/slash-commands/` with a `HandlerDependencies`-style DI seam and a `deploy:commands` script (`src/scripts/deploy-commands.ts`).
- Personal reminder feature (`src/features/reminder/`): `/remind me <duration> "message"` slash command schedules a DM with caps at 7 days duration and 10 active reminders per user; scheduler scans every 30s and reloads from `data/reminders.json` on boot (gitignored) with malformed-file tolerance, matching the timekeeper-history pattern.
- Project-local AI agent dispatchers (`CLAUDE.md` / `AGENTS.md`) pointing to a `docs/` knowledge base (architecture, process, recovery, security, quality).
- Dependabot weekly update PRs (`npm` ecosystem, Asia/Tokyo Monday 09:00).
- Lightweight security workflow (`bun audit --production` + CodeQL on push / PR).
- GitHub issue forms (feature / bug) and a pull request template.
- Sprint / release / agile workflow doc with `release-<major>-<minor>-<patch>` branch model and Issue-only ticket branches.
- Birthday auto-role feature: `/birthday set|remove` slash command, JST 0:00 daily scheduler that grants and removes the `@Birthday` role, optional announcement in a configured text channel, and JSON-persisted registry at `data/birthdays.json`.
- ADR-0002: weekly sprint cadence (1 week) and explicit merge-authorization boundary. Structured recovery-checkpoint schema documented in `docs/recovery.md`. Branch-start contract (mandatory remote-head + immediate Draft PR) and stacked-ticket Done-on-trunk-landing rules added to `docs/process.md`.

### Changed

- Default branch renamed `master` → `main`.
- `.env.example` upgraded to a schema reference (real values are now expected to come from the host's secret manager).
- `README.md` and `CONTRIBUTING.md` no longer instruct to copy `.env.example` into a local `.env`.
- Sprint cadence moved from "2 weeks, adjust as the team learns" to **1 week** (Monday start, Friday end-of-day ship) per the multi-agent project-init policy. Hotfixes still go via `release-x-y-z → main`.
- `docs/process.md` now distinguishes PR readiness from merge authorization: agents may open / update / rebase / re-validate, but may not merge, squash-merge, rebase-merge, enable auto-merge, or execute native stacked-PR landing without an explicit user instruction naming the PR (or a clearly bounded PR set) and the merge action.
- `docs/process.md` now codifies that a stacked ticket is Done only after its changes land on the target release trunk, and that a release branch with a meaningful integrated difference against `main` must carry a Draft release PR.
- `docs/process.md` now documents the public-`main` protection baseline (PR-only, no force-push, ≥1 review, `enforce_admins`, `required_linear_history`, `required_conversation_resolution`, required CI / audit / CodeQL checks, plus a release-source ruleset) and treats any gap as a blocker.
- `biome.json` schema URL bumped from `2.5.7` to `2.5.12` to match the installed Biome CLI; further bumped to `2.5.14` and pinned to `lineEnding: lf` so the formatter matches the committed LF blob on every platform.
- `.gitattributes` pins `* text=auto eol=lf` so `core.autocrlf=true` on Windows stops silently converting tracked text files to CRLF in the working tree.

### Fixed

- `tests/timekeeper-session-clock.test.ts` import sorting + formatting.
- `tests/timekeeper-timeline.test.ts` formatting.
- **Consent logger crash (`src/consent/logger.ts`)**: pino's internal `LOG` helper reads `this[Symbol(pino.msgPrefix)]` and `this[Symbol(pino.write)]`; forwarding a level method without binding `this` (the original `fn(first, second, ...rest)` shape) crashed every consent-scoped log call with `TypeError: Cannot read properties of undefined (reading 'Symbol(pino.msgPrefix)')`. Switched to `fn.call(logger, first, second, ...rest)` so the wrapper preserves the underlying pino logger identity. New `tests/consent/logger.test.ts` pins the contract (info / warn / error / child().info()) and would fail loudly if the regression returns.
- **Pre-existing test failures unblocked the release gate**: `tests/privacy/birthday-gate.test.ts` and `tests/privacy/slash-privacy.test.ts` now chdir back to the test runner's cwd before `rmSync`, since Windows refuses to remove a directory that is still the cwd; `tests/observability/no-console.test.ts` splits `relative()` paths on both POSIX and Windows separators so the `src/scripts/**` allow-list matches regardless of host OS; `tests/state-snapshot.test.ts` uses relative source paths so `restoreSnapshot` honors the caller-supplied `outputDir` (the previous absolute-path setup silently misrouted on POSIX and threw on Windows); `src/lib/storage/__tests__/atomic-json.test.ts` skips the chmod-0o000 readability assertion on Windows, where POSIX permission-bit semantics do not apply to the file owner.

## [0.2.2] — 2026-11-13

### Added

- **Anonymous chat posting `/anon` (#108, ADR-0003)**: post to any ordinary postable guild channel or thread as the bot without exposing the caller's public Discord identity. Effective-permission checks re-fetch channel / guild / member / bot-member / thread-parent state on every invocation and fail closed on unknown or revoked permissions; private-thread membership and `ManageThreads` are honored; mentions are suppressed via `allowedMentions: { parse: [] }`; per-user cooldown and deny lists are enforced; all replies are ephemeral and failures return generic messages.
- **Optional audit mode (`ANON_AUDIT_PUBLIC_KEY`)**: when configured, each post attempt persists an RSA-OAEP-SHA256-sealed record (`{ userId, guildId, channelId, postedAt }` mapping) to `data/anon-audit/` before the public send, using immutable per-record files published via fsync + no-replace hard-link + directory fsync. Only the public key is deployed; the private key stays offline with a custodian. Unset = fully ephemeral mode with no persistence; configured-but-broken = fail closed (`auditState: "error"` refuses all posts). Selective deletion is an offline custodian operation (`bun run anon:audit:delete`); `/privacy delete` honestly reports it cannot selectively delete ciphertext-only records. Retention sweeps stale records and `.tmp` orphans.
- **Operational runbook**: ADR-0003 §3 and `docs/privacy.md` §8.2 document the offline key ceremony, custodian deletion procedure, consent-revocation semantics (stops future writes, not retroactive), and the `auditState: "error"` recovery path.

### Security

- **Dependency advisories (#111)**: bumped `zod` and pinned `undici` past known security advisories; `bun audit --production` is green again.
- **Error-log sanitization**: `safeErrorFields` emits only whitelisted values — known-safe error class names, whitelisted Node errno / undici string codes or bounded numeric Discord codes, and HTTP status 100–599. `error.message`, stacks, payloads, snowflakes, and arbitrary strings can never reach logs, metrics, TUI, or the error-forwarder.

## [0.2.3] — 2026-11-13

### Fixed

- **Slash command routing (#115 / PR #116)**: `src/features/role-slash/handler.ts` and `src/features/slash-commands/handler.ts` replied `unknown command` to any chat-input command outside their own registries. Because discord.js fans out every `InteractionCreate` to all listeners, commands owned by other features (`/anon`, `/role`, `/poll`, `/timekeeper`, `/remind`, `/birthday`, `/calendar`) could receive a competing `unknown command` response — observed in production on `/anon` under v0.2.2. Both dispatchers now return silently for commands they do not own, so each interaction is answered exactly once by its owning handler; unknown *subcommands* within an owned command still return `unknown subcommand`. New `tests/interaction-routing.test.ts` registers all production interaction listeners and asserts exactly-one response across `/anon`, `/role`, `/ping`, `/privacy`, `/timekeeper`, `/poll`, `/help`, and `/birthday`, with zero recorded calls for unowned or non-chat-input interactions.

## [0.3.0] — 2026-11-13

### Added

- **Mandatory anonymous-chat audit (#118, ADR-0003)**: `/anon` audit persistence is no longer optional. Without `ANON_AUDIT_PUBLIC_KEY`, or on any audit init/persist failure, the service refuses every post (`auditState: "disabled" | "active" | "error"`) — the ephemeral no-log posting mode is removed. Each post now writes an encrypted `attempt` record BEFORE the Discord send and a `posted` record carrying the real `messageId` afterwards, correlated by a random `attemptId`. Send failure leaves a safe orphan attempt record; a post-send audit failure deletes the message best-effort, flips `auditState` to `"error"` before awaiting the delete, re-checks state at the send boundary for in-flight posts, and refuses all further posts until restart.
- **Versioned audit envelopes (v2)**: plaintext metadata carries `v`, `kid` (key rotation), `kind`, `gid`, `cid`, `ct`; user id, attempt id, and message id remain inside the RSA-OAEP-SHA256 ciphertext only.
- **Custodian tooling**: `bun run anon:audit:lookup` decrypts records offline by `--message` / `--user` / `--attempt` / `--unmatched` (orphan-attempt anomaly report), accepts multiple `--key-file` for rotation overlap, and fails closed on corrupt/undecryptable/malformed records. Both lookup and `anon:audit:delete` write mandatory fsynced `start`/`end` entries to `operations.jsonl` — lookup cannot decrypt without a durable start record or print plaintext without a durable end record; delete cannot remove records without a durable start record. Entries contain counts only, never query values or ciphertext.
- **Live audit-state propagation**: the service exposes `onAuditStateChange`; a runtime `active → error` degradation is pushed into the status store so the TUI reflects it immediately.

### Changed

- **ADR-0003 revised**: audit is mandatory; documents the two-phase record model, key custody / decrypt-approval / rotation runbook, and the explicit limit that Bot-host administrators cannot be fully excluded from anonymity.
- `docs/privacy.md` and the privacy consumer inventory updated for mandatory audit, custodian lookup/deletion, and consent interplay (no `message-history` grant → `/anon` unavailable).

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
