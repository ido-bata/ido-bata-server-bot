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

### 3. Audit mapping: opt-in, public-key-only, ciphertext-only, fail closed

- When `ANON_AUDIT_PUBLIC_KEY` is **not** set, `/anon` stores nothing.
  The feature is then ephemeral-only (in-memory cooldown). This is the
  default and the privacy-maximal mode; it is a documented mode, not a
  silent scope reduction — the Issue makes persistence conditional
  ("保存する場合").
- When set, every post attempt that passes consent appends one
  record to `data/anon-audit/` BEFORE the public send. Each record
  is its OWN immutable file (`<UTC timestamp>-<random>.jsonl`,
  mode `0600`) containing a single line `{ v, gid, cid, ct }` where
  `gid`/`cid` are plaintext operational metadata (guild, channel)
  and `ct` is RSA-OAEP-SHA256 ciphertext (base64) of the author
  mapping `{ userId, guildId, channelId, postedAt }`. The message
  body is never stored (it lives in the public message). There is
  no plaintext `mid`: Discord assigns the message id only after
  send, and the audit record must be durable before the send — the
  custodian correlates records to messages via the decrypted
  `channelId` + `postedAt`. This key is not unique: attempts in the
  same channel sharing a millisecond `postedAt` produce identical
  keys, so a message cannot be attributed to one author from the key
  alone. Records may exist for send attempts that
  ultimately failed (orphan records): that is deliberate
  over-recording — the safe direction — and retention sweeps them.
- **Concurrency needs no lock.** Each record is written to a hidden
  temp file and atomically published via hard `link` + `unlink` —
  `link` fails `EEXIST` rather than overwriting a final name, and
  readers never see a partial record; appends are independent file
  creations and cannot interleave or lose each other's data —
  across processes too. The retention sweep only removes files whose UTC date prefix
  is older than `ANON_AUDIT_RETENTION_DAYS` (default 90) plus stale
  `.tmp` orphans — it can never include a file being appended
  (appends always carry today's date). Legacy `YYYY-MM-DD.jsonl`
  daily files from earlier revisions are still detected, swept, and
  handled by the custodian (kept-lines rewrite — safe because no
  current writer targets those names). Custodian deletion removes
  whole per-record files AND any `.tmp` files, so a hard-link alias
  left by a failed temp unlink can never survive a completed run —
  a concurrent append can never be dropped. This replaces an earlier daily-JSONL + mkdir-lock design
  whose stale-breaking and read-modify-write paths could not be
  made race-free.
- **No bot-computable per-user index — by design.** An earlier
  revision stored `idx = HMAC(indexKey, userId)` for `/privacy
  delete` lookup. That was rejected: any deterministic tag over a
  Discord user id is dictionary-attackable because guild rosters are
  public — a host admin holding the index key could re-identify every
  author WITHOUT the private key, voiding the entire point of
  public-key encryption. Records therefore carry no `idx`/lookup
  field at all; the bot host cannot re-identify authors from stored
  data.
- Consequence for deletion: the bot cannot selectively remove one
  user's audit records (it cannot even prove which records are
  theirs). `/privacy delete`'s `anonymous-chat-audit` consumer
  reports this honestly — `ok:false` with custodian instructions
  whenever audit files exist — instead of claiming a deletion it
  cannot perform. Actual selective deletion is an OFFLINE custodian
  operation: `bun run anon:audit:delete -- --key-file <private.pem>
  --dir <audit-dir> --user <id>` (`src/scripts/anon-audit-delete.ts`
  → `audit-delete.ts`) decrypts every record file, then removes the
  matching files (legacy daily files are rewritten with kept lines).
  It inspects ALL records before modifying ANY file and aborts on
  corrupt/undecryptable/empty/multi-record-current files — an
  uninspectable record is never assumed safe to keep or drop.
- The private key is never accepted from env — private-key PEM
  material is explicitly rejected — never written to disk, never
  logged. Only public-key material enters the process. The removed
  `ANON_AUDIT_INDEX_KEY` env var is ignored with a warning.
- **Crash durability.** `record()` fsyncs the temp file before
  publishing and fsyncs the directory after the link/unlink, so the
  "audit record durable before send" ordering survives a host crash,
  not just a process exception. Any fsync/publish failure aborts the
  post (`audit_failed`) — the feature fails closed rather than risk
  an unaudited public message.
- **Operational prerequisites (audit mode).** Audit mode is opt-in;
  ephemeral mode (`ANON_AUDIT_PUBLIC_KEY` unset) is complete without
  any of the following and is the correct default until the custodian
  role is staffed:
  1. **Key ceremony**: an RSA keypair is generated OFFLINE (e.g.
     `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072`).
     The private key goes only to the custodian's secure store
     (HSM / password manager / air-gapped media) — never to the bot
     host, never to env, never to a repo. Only the public key
     (PEM `-----BEGIN PUBLIC KEY-----` or base64 SPKI DER) is
     configured via `ANON_AUDIT_PUBLIC_KEY`.
  2. **Selective deletion**: a user deletion request is handled by
     the custodian running
     `bun run anon:audit:delete -- --key-file <private.pem> --dir
     <audit-dir> --user <id>` against the live audit directory
     (preferred, during a quiet window) or a copy of it. A copy-based
     run only changes the copy: the custodian must then apply the
     same deletions to the authoritative directory (re-run against
     it, or remove the identified files), and records created AFTER
     the copy was taken are not covered by that run — they remain
     until retention or a later deletion. The script inspects every
     record before modifying anything: inspection anomalies abort
     the run with NO modifications, while an operational failure
     during the delete phase itself can leave partial progress —
     safe to rerun after fixing the cause since inspection is
     deterministic.
  3. **Consent revocation**: revoking `message-history` stops FUTURE
     audit writes immediately (the consent gate fails closed). It
     does NOT retroactively delete records already written — those
     remain until the retention sweep or a custodian deletion run.
     This is documented honestly in `docs/privacy.md`; a user who
     revokes and wants existing records gone must go through the
     custodian path.
  4. **Failure response**: `auditState: "error"` (visible in the
     status store/TUI) means every `/anon` post is refused — this is
     intentional fail-closed behavior, not a bug to bypass. Fix the
     key material or directory permissions, or unset
     `ANON_AUDIT_PUBLIC_KEY` to return to ephemeral mode.
- Audit files/dirs are created `0600`/`0700`; the audit directory is
  created eagerly at sink construction so a fresh deployment or bad
  permissions surfaces as `auditState: "error"` at startup. The
  retention sweep runs at service start and before each append.
- Ordering per post: audit-health → validate → cooldown → deny-list →
  resolve → consent → seal → append audit → `channel.send`. Because
  the audit record is durable BEFORE the public send, no public
  anonymous message can exist without its audit record — including
  the crash window and the "send accepted but response lost" case.
  A seal or append failure rejects the post before any public side
  effect (`audit_failed`); a failed send leaves only an orphan
  record. This replaces the earlier send-then-record design whose
  rollback-delete could not cover process termination or a failed
  rollback.
- **Configured-but-broken audit refuses ALL posts.** `ANON_AUDIT_PUBLIC_KEY`
  set but the sink fails to initialize (invalid key material) →
  `auditState: "error"`, every `/anon` call returns unavailable, and
  the status store reports the error. Only the explicit "key unset"
  configuration yields ephemeral mode — a configured audit must
  never silently degrade to unlogged anonymous posting.
- Consent: when the consent subsystem is deployed, audit writes
  require an active `message-history` grant (fail closed on
  `service-unavailable`). When consent is not deployed at all, the gate
  is absent — same precedent as poll/reminder.
- Snapshot exclusion: `data/anon-audit/` is deliberately **not** added
  to `DEFAULT_SNAPSHOT_SOURCE_PATHS`. Snapshots have their own longer
  retention and would defeat the audit log's bounded retention;
  `docs/privacy.md` records this exception.

### 4. Anonymity across observability sinks

- The `/anon` execute path defers ephemerally inside the 3-second
  acknowledgement window, catches all errors, and delivers only
  generic ephemeral edits; it never throws into the unguarded
  `InteractionCreate` dispatcher (which would forward stacks —
  potentially containing ids — to the error channel). A successful
  post is never retried on reply failure.
- No log call in the feature passes `user`, `userId`, `member`,
  `interaction`, message content, `error.message`, `error.stack`, or
  `error.rawError`. All failures are logged via `safeErrorFields`,
  which emits only `errName`/`errCode`/`errStatus` — Discord error
  codes and HTTP statuses are enum values, never user data.
- TUI/status-store meta carries counts/state only. Metrics are not
  wired with per-user labels.

## Consequences

- Easier: default deployment stores nothing; audit is a pure ops
  opt-in; permission logic is unit-testable without a Discord client.
- Harder: thread permission resolution relies on Discord's
  no-thread-overwrites invariant — if Discord ever ships thread
  overwrites this ADR and `permissions.ts` must be revisited;
  ops must run a key ceremony before audit mode is meaningful.
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
- **HMAC-SHA256 lookup index for `/privacy delete`.** Rejected: any
  deterministic per-user tag computable by the bot is
  dictionary-attackable over the public guild roster — the host admin
  could re-identify authors using only the index key, without the
  private key. Ciphertext-only records + offline custodian deletion
  preserve the guarantee; the cost is that bot-side `/privacy delete`
  reports an honest failure requiring the custodian.
- **Use `interaction.memberPermissions` directly.** Rejected as sole
  check: it is computed for the interaction channel but we re-derive
  permissions anyway for the bot member and thread parent/membership
  correctness; also keeps the logic testable via DI.
- **Webhook-based posting.** Rejected: webhook messages still carry no
  author id, but webhook management adds a secret and audit-channel
  interplay for no anonymity gain over bot-authored messages (bot
  messages are already skipped by message-audit `isBot` checks).

## References

- Issue #108 (acceptance criteria)
- `docs/privacy.md` §3 consumer inventory
- discord.js `GuildChannel.memberPermissions` / `ThreadChannel.permissionsFor`
  (node_modules/discord.js@14.27.0)
