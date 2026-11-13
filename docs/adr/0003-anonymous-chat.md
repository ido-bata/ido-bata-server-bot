# ADR-0003 — `/anon` anonymous chat: threat model, permission model, and audit-key custody

- Status: Accepted (revised 2026-11-13 per Issue #118; supersedes the
  opt-in audit design shipped in v0.2.2/v0.2.3)
- Date: 2026-11-13 (original), revised 2026-11-13
- Deciders: maintainer (Issue #108 spec, Issue #118 reconfirmed
  requirements), implementing agent
- Related: Issue #108, Issue #118, `docs/privacy.md`, ADR-0002

## Context

Issue #108 asks for `/anon message:<body>` that reposts a message into the
invoking channel/thread without exposing the author's Discord identity in
the public message or in bot-visible replies. Issue #118 reconfirms the
audit requirements and adds decisions the original ADR left open:

1. How "the user could post here normally" is evaluated, including
   threads and permission overwrites.
2. The audit mapping is now **mandatory**: every anonymous post must
   leave an encrypted author↔message record; there is no unlogged
   posting mode.
3. The audit record must correlate to the **actual Discord messageId**,
   not merely `channelId + postedAt`.
4. Who custodies the decryption key — explicitly undecided by the
   Issue ("鍵の保管者…が確定していないため、現在は仕様整理段階").
   The bot only ever receives the public key; custody, decrypt
   approval, operation records, and rotation are operational
   procedures documented in `docs/privacy.md` §8 and implemented by
   offline custodian tooling.
5. How the feature interacts with the consent registry, `/privacy
   delete`, retention, snapshots, and every log/metric/audit sink.

This ADR fixes those decisions so implementation and review have a
single authority. It deliberately does **not** claim anonymity stronger
than the platform allows.

## Threat model (explicit non-goals)

- **Guaranteed**: the bot's *public* repost contains no user id, name,
  mention, or avatar; ephemeral replies are identical for every caller;
  no bot log, metric, audit forward, TUI panel, snapshot, or error
  forward contains the author id, message body, or decrypted audit
  content in plaintext; a user who cannot post in a channel cannot make
  the bot post there; **every** anonymous post leaves a durable
  RSA-OAEP ciphertext record that the bot cannot decrypt, and every
  successfully posted message is linked to its author record through a
  second ciphertext record carrying the real `messageId`.
- **Not guaranteed**: Discord itself delivers `interaction.user.id` to
  the bot at invocation time. A host administrator who can modify bot
  code, inspect process memory, or attach a debugger can identify
  authors. Public-key encryption protects the *stored* mapping, not the
  live interaction. We do not claim "operators can never identify".
- The audit decryption key custody procedure (who holds the private
  key, how many approvals are needed to decrypt) is an **operational**
  decision outside this repo. The bot only ever receives the public
  key. If no public key is configured, `/anon` refuses all posts —
  audit is not optional.

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
- The command `deferReply({ ephemeral: true })`s immediately — the
  permission pipeline performs several REST lookups and Discord
  requires acknowledgement within ~3 s — then delivers the outcome via
  `editReply`. A successful public post is never retried: if
  `editReply` fails after `post()` returned ok, the anonymous message
  is already live and the command stops.
- All user-facing replies are ephemeral and generic; failures never
  echo the body or identify which check failed beyond coarse categories
  (cooldown vs. denied vs. unavailable). Bot-side permission gaps also
  produce the generic unavailable reply — no "bot lacks permission"
  detail that would leak channel/bot configuration.

### 2. Authorization = "could this member post a normal message here"

`src/features/anonymous-chat/permissions.ts` computes effective
permissions mirroring discord.js `GuildChannel.memberPermissions`
(role permissions → `@everyone` overwrite → role overwrites → member
overwrite), with these rules:

- Require `ViewChannel` plus `SendMessages` (text/announcement/voice
  channels) or `SendMessagesInThreads` (threads).
- **Threads**: Discord threads have **no permission overwrites of
  their own** — they inherit the parent channel's overwrites
  wholesale, and discord.js `ThreadChannel.permissionsFor` reflects
  exactly that by delegating to the parent. We resolve
  `parent.permissionsFor(member)` and apply nothing further.
  Guild owner and `Administrator` bypass overwrites (checked before
  overwrite application). `locked !== false` → deny — discord.js types
  `locked` as `boolean | null`, and an unknown state fails closed.
  Private threads additionally require thread membership for the
  invoking user (`thread.members.fetch`) OR `ManageThreads` — the same
  moderator path Discord grants for normal posting; fetch failure →
  deny. The bot member gets the same preflight: in a private thread it
  must be a thread member or hold `ManageThreads`, otherwise the post
  is denied before send. Archived (unlocked) threads are allowed —
  Discord permits posting, which unarchives.
- The bot member's effective permissions on the same channel must also
  include the send bit; otherwise the user gets a generic denial.
- Any resolution failure — channel/member/parent fetch error, missing
  parent, non-guild channel, DM, category, forum — is **deny**
  (fail closed). All Discord lookups use `force: true` refreshes so
  cached roles/overwrites/membership cannot stale a security decision.
- `ANON_DENY_CHANNEL_IDS` (comma-separated) is an optional deny-list
  applied *in addition to* the permission check; it never replaces it.
  Default empty.
- Cooldown: 30 s per user (`ANON_COOLDOWN_SECONDS`), in-memory only,
  never persisted and never logged with the user id. It is consumed on
  each attempt that passes message validation — including attempts
  later denied — to bound permission-probing and API abuse.

### 3. Audit mapping: mandatory, public-key-only, ciphertext-only, fail closed

**Audit is required. There is no unlogged posting mode.** The earlier
opt-in design ("`ANON_AUDIT_PUBLIC_KEY` unset → ephemeral, stores
nothing") is withdrawn: it allowed anonymous posts with no durable
author mapping, which violates the reconfirmed requirement that every
anonymous post's correspondence information be stored encrypted.

- `ANON_AUDIT_PUBLIC_KEY` **unset** → the service reports
  `auditState: "disabled"` and **refuses every post** (`unavailable`).
  This is distinct from `auditState: "error"` (key configured but
  invalid / sink init failed) only for operator clarity — both refuse.
  A startup warning is logged so a missing key is visible, not silent.
- `ANON_AUDIT_PUBLIC_KEY` set but the key material is invalid or the
  audit directory cannot be initialized → `auditState: "error"`,
  every `/anon` call returns unavailable. A configured audit must
  never silently degrade.
- Only the explicit, documented configuration yields a working
  `/anon`: valid public key + writable audit directory + (when the
  consent subsystem is deployed) an active `message-history` grant.

#### Record format (v2): two-phase attempt/posted records

Discord assigns the `messageId` only **after** `channel.send`
resolves, but the audit record must be durable **before** the public
send (no public anonymous message may exist without its audit
record). The design reconciles both with two immutable records per
post:

1. **Attempt record** — written and fsynced BEFORE `channel.send`.
   Envelope `{ v: 2, kid, kind: "attempt", gid, cid, ct }` where `ct`
   seals `{ v: 2, kind: "attempt", attemptId, userId, guildId,
   channelId, postedAt }`. `attemptId` is `randomBytes(16)` hex —
   random, never derived from the user id, so it cannot serve as a
   re-identification index.
2. **Posted record** — written and fsynced immediately after a
   successful send, carrying the real `message.id`. Envelope
   `{ v: 2, kid, kind: "posted", gid, cid, ct }` where `ct` seals
   `{ v: 2, kind: "posted", attemptId, messageId, userId, guildId,
   channelId, postedAt }`. The posted payload is **self-contained**:
   the custodian maps `messageId → userId` directly from this record
   without joining attempt records (the `attemptId` is still present
   for anomaly cross-checks).

`kid` is the key id (`ANON_AUDIT_KEY_ID`, default `"v1"`) written in
plaintext in the envelope — a non-secret label that lets the custodian
select the right private key after rotation. `gid`/`cid` remain
plaintext operational metadata. The message body is never stored.

#### Failure and crash semantics

- Seal or attempt-append failure → post rejected **before** any public
  side effect (`audit_failed`).
- Send failure → `post_failed`; the attempt record remains as an
  orphan (over-recording — the safe direction, swept by retention).
- Send succeeds but the response is lost / process crashes before the
  posted record → the public message exists with only its attempt
  record. This residual window cannot be eliminated without a Discord
  transaction; it is bounded to the send→record interval, the attempt
  record still binds author+channel+time, and custodian tooling
  reports attempt records lacking a posted link as anomalies.
- **Posted-record append failure after a successful send** → the
  service attempts `message.delete()` (best effort), marks
  `auditState: "error"` so subsequent posts refuse until operator
  intervention, and returns `audit_failed`. Rationale: continuing to
  post would accumulate live anonymous messages without exact
  messageId correlation — the invariant this revision exists to
  guarantee. Fail closed, consistent with every other audit failure.
- Concurrency needs no lock (unchanged): each record is its own
  immutable file published via fsync + no-replace hard-link +
  directory fsync; appends cannot interleave or lose data.
- Retention sweep (default 90 days, `ANON_AUDIT_RETENTION_DAYS`)
  removes expired record files and stale `.tmp` orphans on a timer,
  at startup, and before each append. `data/anon-audit/` stays
  excluded from state snapshots.

#### No bot-computable per-user index — by design (unchanged)

Any deterministic tag over a Discord user id is dictionary-attackable
over the public guild roster, so records carry no `idx`/lookup field.
The bot host cannot re-identify authors from stored data. `/privacy
delete`'s `anonymous-chat-audit` consumer keeps reporting the honest
`ok:false` + custodian instructions whenever audit files exist;
selective deletion remains an offline custodian operation
(`bun run anon:audit:delete`), which now also covers v2 records
(both kinds carry `userId`).

#### Custodian correlation and operations

- **Lookup**: `bun run anon:audit:lookup -- --key-file <private.pem>
  --dir <audit-dir> --message <messageId>` (or `--user <id>`,
  `--attempt <attemptId>`, `--unmatched`) decrypts records offline
  and prints the correlation. This is the only path that maps a real
  Discord `messageId` to an author, and it requires the private key.
- **Operation records**: custodian tools append privacy-safe
  `start`/`end` entries to `<audit-dir>/operations.jsonl` —
  timestamp, operation, phase, records scanned/matched/removed,
  key count. The records are MANDATORY, not best-effort: lookup
  writes `start` before any decryption and `end` before plaintext
  is printed — a failed `end` append withholds all decrypted
  output; delete writes `start` before any record is removed — a
  failed `start` aborts the run entirely — and `end` after, with a
  failed `end` reported loudly. Appends are fsynced (file + directory)
  before the tool proceeds, so an acknowledged record survives a
  crash. No disclosure or deletion completes without a durable
  operation record. Query values (user ids,
  message ids) are never written to the ops log; the custodian
  keeps the approval record (who approved, why, when) in their own
  procedure outside the repo.
- **Key rotation**: generate a new RSA-3072 keypair offline, deploy
  only the new public key with a new `ANON_AUDIT_KEY_ID`, keep the
  old private key until the retention window has drained old `kid`
  records. The decrypt/lookup/delete tools accept the key file
  matching each record's `kid` (tools try the provided key and
  report `kid` mismatches rather than guessing).
- **Private key handling (unchanged)**: private-key PEM material is
  explicitly rejected from `ANON_AUDIT_PUBLIC_KEY`; the private key
  never enters the bot process, env, disk on the bot host, or logs.

#### Consent

When the consent subsystem is deployed, audit writes require an
active `message-history` grant (fail closed on
`service-unavailable`/deny → generic `unavailable` reply). Because
audit is now mandatory, a user without the grant simply cannot use
`/anon` — the denial is indistinguishable from other unavailable
states by design. When consent is not deployed at all, the gate is
absent — same precedent as poll/reminder; changing that precedent
requires touching this ADR and `docs/privacy.md` together. Consent
revocation stops future audit writes immediately; existing records
remain until retention or custodian deletion (documented honestly).

### 4. Anonymity across observability sinks

- The `/anon` execute path defers ephemerally inside the 3-second
  acknowledgement window, catches all errors, and delivers only
  generic ephemeral edits; it never throws into the unguarded
  `InteractionCreate` dispatcher (which would forward stacks —
  potentially containing ids — to the error channel). A successful
  post is never retried on reply failure.
- No log call in the feature passes `user`, `userId`, `member`,
  `interaction`, message content, `error.message`, `error.stack`, or
  `error.rawError`, `attemptId`, `messageId`, or decrypted audit
  content. All failures are logged via `safeErrorFields`, which emits
  only `errName`/`errCode`/`errStatus` — Discord error codes and HTTP
  statuses are enum values, never user data.
- TUI/status-store meta carries counts/state only (the `auditState`
  value itself). Metrics are not wired with per-user labels. The
  posted-record failure path logs only safe fields plus the audit
  state transition — never the message id or user id. Runtime
  `active → error` transitions are pushed to the status store via
  the service's `onAuditStateChange` callback, so the TUI reflects
  the degradation immediately rather than showing a stale "active".
- `operations.jsonl` (custodian ops log) contains no user ids,
  message ids, attempt ids, or ciphertext — counts and key counts
  only.

## Consequences

- Easier: one invariant — "no anonymous post without encrypted audit"
  — replaces the two-mode (ephemeral/audit) matrix; custodian
  correlation is exact (`messageId → userId`) instead of
  channel+time approximate.
- Harder: ops MUST provision an RSA keypair and set
  `ANON_AUDIT_PUBLIC_KEY` before `/anon` works at all — a missing key
  is now an outage for the feature, surfaced as `auditState:
  "disabled"` + startup warning. Each post writes two files instead
  of one. The send→posted-record crash window is a documented,
  bounded residual risk.
- Constrained: thread permission resolution relies on Discord's
  no-thread-overwrites invariant — if Discord ever ships thread
  overwrites this ADR and `permissions.ts` must be revisited;
  key rotation requires the `kid` envelope field and custodian key
  retention for the rotation window; enabling audit without consent
  configured relies on the poll/reminder precedent.

## Alternatives considered

- **Opt-in audit / ephemeral mode (v0.2.2–0.2.3 behavior).**
  Withdrawn by Issue #118: unlogged anonymous posting violates the
  reconfirmed requirement. Replaced by mandatory audit with
  `disabled`/`error` both refusing posts.
- **Send first, then write the audit record containing messageId.**
  Rejected: a crash or send-response loss between the public post and
  the record would leave a live anonymous message with no audit —
  exactly the gap the pre-send record exists to close.
- **Single mutable record amended post-send.** Rejected: rewriting a
  published record reintroduces partial-write/read races the
  immutable-file design eliminated, and a crash mid-rewrite could
  destroy the pre-send guarantee.
- **Store `messageId` plaintext in the envelope for bot-side
  indexing.** Rejected: a plaintext `messageId → file` index would let
  the bot host correlate stored records to public messages without
  the private key — a re-identification path. `messageId` stays
  inside the ciphertext.
- **HMAC-SHA256 lookup index for `/privacy delete`.** Rejected
  (unchanged): any deterministic per-user tag computable by the bot
  is dictionary-attackable over the public guild roster.
- **Symmetric key in env.** Rejected (unchanged): the bot host would
  hold the decryption key.
- **Webhook-based posting.** Rejected (unchanged): adds a secret and
  audit-channel interplay for no anonymity gain.
- **Use `interaction.memberPermissions` directly.** Rejected as sole
  check (unchanged): we re-derive permissions for the bot member and
  thread parent/membership correctness, and keep the logic testable
  via DI.

## References

- Issue #108 (original acceptance criteria), Issue #118 (reconfirmed
  audit requirements)
- `docs/privacy.md` §3 consumer inventory, §8 anonymous-chat runbook
- discord.js `GuildChannel.memberPermissions` / `ThreadChannel.permissionsFor`
  (node_modules/discord.js@14.27.0)
