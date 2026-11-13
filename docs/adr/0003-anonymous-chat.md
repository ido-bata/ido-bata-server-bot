# ADR-0003 — `/anon` anonymous chat: threat model, permission model, and audit-key custody

- Status: Accepted (implementation in progress on branch `108`)
- Date: 2026-11-13
- Deciders: maintainer (Issue #108 spec), implementing agent
- Related: Issue #108, `docs/privacy.md`, ADR-0002

## Context

Issue #108 asks for `/anon message:<body>` that reposts a message into the
invoking channel/thread without exposing the author's Discord identity in
the public message or in bot-visible replies. The Issue leaves several
security-relevant decisions open:

1. How "the user could post here normally" is evaluated, including
   threads and permission overwrites.
2. Whether the bot persists a message↔author mapping for audit, and if
   so, how the bot host cannot read it.
3. Who custodies the decryption key — explicitly undecided by the Issue
   ("鍵の保管者…が確定していないため、現在は仕様整理段階").
4. How the feature interacts with the consent registry, `/privacy
   delete`, retention, snapshots, and every log/metric/audit sink.

This ADR fixes those decisions so implementation and review have a
single authority. It deliberately does **not** claim anonymity stronger
than the platform allows.

## Threat model (explicit non-goals)

- **Guaranteed**: the bot's *public* repost contains no user id, name,
  mention, or avatar; ephemeral replies are identical for every caller;
  no bot log, metric, audit forward, TUI panel, snapshot, or error
  forward contains the author id or message body in plaintext; a user
  who cannot post in a channel cannot make the bot post there; the
  author↔message mapping, when audit is enabled, is stored only as
  RSA-OAEP ciphertext that the bot cannot decrypt.
- **Not guaranteed**: Discord itself delivers `interaction.user.id` to
  the bot at invocation time. A host administrator who can modify bot
  code, inspect process memory, or attach a debugger can identify
  authors. Public-key encryption protects the *stored* mapping, not the
  live interaction. We do not claim "operators can never identify".
- The audit decryption key custody procedure (who holds the private
  key, how many approvals are needed to decrypt) is an **operational**
  decision outside this repo. The bot only ever receives the public
  key. Until ops deploys a keypair, audit persistence is simply off.

## Decision

### 1. Command surface

- `/anon` is a `SlashCommandDefinition` in
  `src/features/slash-commands/commands/anon.ts`, registered in the base
  registry (`defaultDefinitions`) so it deploys through the existing
  aggregated guild-command PUT. Permission tier: `everyone` in
  `src/features/slash-permissions/config.ts` — real authorization is the
  per-channel effective-permission check below, not the command tier.
- Option: `message` (string, required). Trimmed length must be 1–1000
  chars (`ANON_MAX_MESSAGE_LENGTH`). Repost uses
  `allowedMentions: { parse: [] }` so `@everyone`/`@user`/`@role` in the
  body cannot ping anyone.
- All user-facing replies are ephemeral and generic; failures never
  echo the body or identify which check failed beyond coarse categories
  (cooldown vs. denied vs. unavailable).

### 2. Authorization = "could this member post a normal message here"

`src/features/anonymous-chat/permissions.ts` computes effective
permissions mirroring discord.js `GuildChannel.memberPermissions`
(role permissions → `@everyone` overwrite → role overwrites → member
overwrite), with these rules:

- Require `ViewChannel` plus `SendMessages` (text/announcement/voice
  channels) or `SendMessagesInThreads` (threads).
- **Threads**: discord.js `ThreadChannel.permissionsFor` delegates
  *only* to the parent and ignores thread-level overwrites, so we
  resolve `parent.permissionsFor(member)` and then apply the thread's
  own `permissionOverwrites` with the same ordering. Guild owner and
  `Administrator` bypass overwrites (checked before overwrite
  application). `locked === true` → deny. Private threads additionally
  require thread membership (`thread.members.fetch(userId)`); fetch
  failure → deny. Archived (unlocked) threads are allowed — Discord
  permits posting, which unarchives.
- The bot member's effective permissions on the same channel must also
  include the send bit; otherwise the user gets a generic denial
  (no "bot lacks permission" detail that would leak config).
- Any resolution failure — channel/member/parent fetch error, missing
  parent, non-guild channel, DM, category, forum — is **deny**
  (fail closed).
- `ANON_DENY_CHANNEL_IDS` (comma-separated) is an optional deny-list
  applied *in addition to* the permission check; it never replaces it.
  Default empty.
- Cooldown: 30 s per user (`ANON_COOLDOWN_SECONDS`), in-memory only,
  never persisted and never logged with the user id. It is consumed on
  each attempt that passes message validation — including attempts
  later denied — to bound permission-probing and API abuse.

### 3. Audit mapping: opt-in, public-key-only, fail closed

- When `ANON_AUDIT_PUBLIC_KEY` is **not** set, `/anon` stores nothing.
  The feature is then ephemeral-only (in-memory cooldown). This is the
  default and the privacy-maximal mode; it is a documented mode, not a
  silent scope reduction — the Issue makes persistence conditional
  ("保存する場合").
- When set, every successful post appends one record to
  `data/anon-audit/YYYY-MM-DD.jsonl` (UTC day files):
  `{ v, idx, gid, cid, ct }` where `ct` is RSA-OAEP-SHA256 ciphertext
  (base64) of `{ messageId, userId, guildId, channelId, postedAt }`,
  `idx` is `HMAC-SHA256(ANON_AUDIT_INDEX_KEY, userId)` for `/privacy
  delete` lookup, and `gid`/`cid` are plaintext operational metadata.
  The message body is never stored (it lives in the public message).
- `ANON_AUDIT_INDEX_KEY` is a random bot-held secret used **only** for
  the HMAC lookup; it cannot decrypt. Both env vars are required
  together — public key without index key disables audit with an error
  log (never silently stores undeletable records).
- The private key is never accepted from env, never written to disk,
  never logged. Only `createPublicKey` material enters the process.
- Ordering per post: validate → authorize → encrypt → cooldown commit →
  `channel.send` → append audit. If encryption fails, the post is
  rejected **before** sending (fail closed, no plaintext fallback). If
  the audit append fails after a successful send, the bot attempts to
  delete the just-posted message and reports failure — an anonymous
  post must never exist without its audit record when audit is on.
- Retention: daily files older than `ANON_AUDIT_RETENTION_DAYS`
  (default 90) are swept on service start and before each append.
- `/privacy delete`: the `anonymous-chat-audit` consumer recomputes the
  user's `idx` and removes matching lines (atomic rewrite per file).
  Missing index key with existing files → reported as failure, never
  silent success.
- Consent: when the consent subsystem is deployed, audit writes
  require an active `message-history` grant (fail closed on
  `service-unavailable`). When consent is not deployed at all, the gate
  is absent — same precedent as poll/reminder.
- Snapshot exclusion: `data/anon-audit/` is deliberately **not** added
  to `DEFAULT_SNAPSHOT_SOURCE_PATHS`. Snapshots have their own longer
  retention and would defeat the audit log's bounded retention;
  `docs/privacy.md` records this exception.

### 4. Anonymity across observability sinks

- The `/anon` execute path catches all errors and replies generically;
  it never throws into the unguarded `InteractionCreate` dispatcher
  (which would forward stacks — potentially containing ids — to the
  error channel).
- No log call in the feature passes `user`, `userId`, `member`,
  `interaction`, or message content. Discord API errors are logged as
  `{ err }` only (Discord error bodies do not echo request content).
- TUI/status-store meta carries counts/state only. Metrics are not
  wired with per-user labels.

## Consequences

- Easier: default deployment stores nothing; audit is a pure ops
  opt-in; permission logic is unit-testable without a Discord client.
- Harder: thread permission resolution duplicates a slice of
  discord.js internals — covered by dedicated tests; ops must run a
  key ceremony before audit mode is meaningful.
- Constrained: enabling audit without consent configured relies on the
  poll/reminder precedent; changing that precedent requires touching
  this ADR and `docs/privacy.md` together.

## Alternatives considered

- **Always require the audit key (fail closed without it).** Rejected:
  key custody is an unresolved ops decision; blocking the whole feature
  on it would stall Issue #108 without improving privacy (no key → no
  stored mapping is strictly more private).
- **Store the mapping encrypted with a symmetric key in env.** Rejected:
  the bot host would hold the decryption key, violating the Issue's
  "secret key must not reach the bot" requirement.
- **Use `interaction.memberPermissions` directly.** Rejected as sole
  check: it is computed for the interaction channel but we re-derive
  permissions anyway for the bot member and thread-overwrite correctness;
  also keeps the logic testable via DI.
- **Webhook-based posting.** Rejected: webhook messages still carry no
  author id, but webhook management adds a secret and audit-channel
  interplay for no anonymity gain over bot-authored messages (bot
  messages are already skipped by message-audit `isBot` checks).

## References

- Issue #108 (acceptance criteria)
- `docs/privacy.md` §3 consumer inventory
- discord.js `GuildChannel.memberPermissions` / `ThreadChannel.permissionsFor`
  (node_modules/discord.js@14.27.0)
