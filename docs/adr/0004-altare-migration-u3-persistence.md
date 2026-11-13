# ADR-0004 — Altare migration: U3-backed persistence layer and single-instance lease

- Status: Accepted (implementation in progress on branch `121`)
- Date: 2026-11-14
- Deciders: maintainer (Issue #121), implementing agent
- Related: Issue #121, ADR-0003, `docs/privacy.md`, `docs/architecture.md`, `docs/operations/altare-migration.md`

## Context

The bot currently runs on a single Windows host (`bun run start` / `tsx`),
with all persistent state written under `data/`:

| Path | Content | Personal data |
| --- | --- | --- |
| `data/consent.json` | consent registry (subject id → scope → grant/revoke) | yes |
| `data/timekeeper-history.json` | timekeeper attendance per user | yes |
| `data/calendar-cache.json` | iCal event cache | no |
| `data/anon-audit/*.jsonl` | RSA-OAEP-encrypted `/anon` author mappings (mandatory from v0.3.0) | ciphertext only |
| `data/anon-audit/operations.jsonl` | mandatory custodian operation log (v0.3.0) | no |
| `data/snapshots/*.snap.enc` | AES-256-GCM mirrors of consent-gated files | encrypted |
| `data/{polls,reminders,birthdays,scheduled-announcements,config}.json`, `data/guilds/**` | per-feature stores | mixed |

The target runtime is Altare's free hosting (App Hosting / Bot Hosting) with
a GitHub-linked deploy that is already wired up. Altare's constraints
(verified 2026-11-14 against `docs.altare.gg`):

- An app deployed from GitHub is built from a clone of the repository, so
  runtime-created files under `data/` are **not** guaranteed to survive a
  redeploy. The app's own disk is a team-wide pool (10 GB on Always Free)
  and Altare's "Backups" feature copies app files, not user data with a
  retention contract.
- U3 is an S3-compatible object store (10 GB / 5 buckets on Always Free,
  free egress, 3 replicas). Connecting a bucket to an app injects
  `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE`,
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and redeploys the app.
- KV (25 MiB values, ≥60 s TTL), Postgres, MySQL and Valkey are also
  available, but the data here is a small set of file-shaped records plus
  an append-only audit log — object storage matches that shape directly.

Requirements that constrain the design (Issue #121):

1. No loss of any record accumulated so far, with verifiable counts and
   checksums at cutover.
2. The audit guarantee from ADR-0003 must not weaken: a public anonymous
   message may only exist if its audit record is already durable, and any
   storage failure must fail closed (refuse the post / deny the grant),
   never degrade to unlogged or silent-allow behaviour.
3. The old host's data must not be deleted.
4. The old bot and the new bot must not process the same events
   concurrently.

## Decision

### 1. A storage abstraction with two backends

`src/lib/storage/` defines a `StorageDriver` interface — the only way
persisted state is reached:

```text
read(key) -> Uint8Array | null        # null == missing
readText(key) -> string | null
write(key, data)                      # atomic replace
writeExclusive(key, data) -> boolean  # create-if-absent; false == exists
list(prefix) -> StorageEntry[]        # key, size, lastModified
delete(key)
exists(key) -> boolean
move(from, to)
```

Two implementations:

- `LocalFileStorage` — the current behaviour, unchanged: temp file +
  `rename(2)` for atomic replace, `open(O_EXCL)` for create-if-absent.
  Root directory is `DATA_DIR` (default `<cwd>/data`).
- `U3Storage` — S3-compatible object storage via `@aws-sdk/client-s3`
  with path-style addressing (`forcePathStyle: true`), endpoint and
  region taken from `S3_ENDPOINT` / `S3_REGION` (with `U3_*` aliases),
  bucket from `S3_BUCKET`. `PUT` is the atomic replace; create-if-absent
  uses `If-None-Match: *` and verifies the stored owner by reading the
  object back, so a backend that ignores the conditional header still
  cannot hand the lease to two owners.

`STORAGE_BACKEND=local` (default) keeps the current host's behaviour
byte-for-byte; `STORAGE_BACKEND=u3` selects the object store.

### 2. Every persistent write path goes through the driver

Consent registry, timekeeper attendance, iCal cache, `/anon` audit
records and the custodian operation log, state-snapshot bundles, the
privacy-delete consumers, and the remaining feature stores (polls,
reminders, birthdays, scheduled announcements, multi-guild config,
hot-reload config) all read and write through the driver. No feature
keeps a private `node:fs` path into `data/`.

### 3. Fail-closed on storage errors

A driver error is never swallowed:

- `ConsentService.authorize()` returns `{ ok: false, reason:
  "service-unavailable" }` (unchanged contract) — a grant is denied when
  the registry cannot be read or written.
- `/anon` refuses the post and reports `audit_failed`; `auditState`
  becomes `error` until storage recovers.
- State-snapshot writes abort; the snapshot is not published partially.
- Privacy delete reports failure for the affected consumer instead of
  claiming success.

### 4. Single-instance lease

The bot acquires `locks/instance.json` in the storage backend at startup
(`writeExclusive`, owner id = hostname + pid + boot id, expiry = now +
TTL). A live lease held by a different owner aborts startup with an
explicit error; the holder renews the lease every TTL/3 and releases it on
shutdown. The lease lives in the same backend as the data, so it survives
restarts and redeploys and still blocks a second instance.

### 5. Migration tooling

`bun run storage:migrate -- <export|import|verify>`:

- `export` — writes a manifest (per-file size + sha256 + record counts)
  and a copy of every file from a local `data/` root.
- `import` — uploads the exported files into a target backend, verifying
  each sha256 after the write; refuses to overwrite existing objects
  unless `--allow-overwrite` is passed.
- `verify` — compares two backends file-by-file (size + sha256) and
  reports counts, so the cutover can assert "same data" rather than
  "upload succeeded".

The old host's `data/` is never deleted by these tools.

### 6. Backup and restore

- U3 is the source of truth. The runtime instance never treats the app's
  local disk as authoritative.
- Backups are (a) scheduled exports from the running instance to a
  second U3 bucket / off-host copy, and (b) Altare app-file Backups as a
  secondary, non-authoritative copy. Restore = import a manifest into a
  fresh backend and re-run `verify`.
- Retention for `/anon` audit files stays `ANON_AUDIT_RETENTION_DAYS`
  (default 90 days) and is enforced by the same sweep, now against the
  driver.

### 7. Altare runtime configuration (documented, not implied)

Install `bun install --frozen-lockfile`, build `bun run build`, start
`node dist/index.js`; the health endpoint listens on `PORT` and is
reachable at `/health`. Secrets (Discord token, `ANON_AUDIT_PUBLIC_KEY`,
U3 keys) live in Altare app variables only — never in git, Issues, PRs
or logs. The Discord token is rotated at cutover so the stopped host's
copy cannot be reused.

## Consequences

- The data root becomes a port: features no longer know whether they run
  on a disk or in object storage, and the Altare deploy needs no
  feature-specific change.
- Writes are no longer free: every persisted mutation becomes an object
  round-trip on the `u3` backend. The privacy-critical paths are small
  and infrequent (a grant, an attendance day, an audit record), so the
  latency is acceptable; bulk paths (calendar cache) are unchanged in
  shape.
- The audit store's local implementation used hard links to publish a
  record atomically. Object storage replaces that with a single atomic
  `PUT` under a unique key — same guarantee (readers never see a
  partial record), fewer moving parts.
- The app's local disk becomes a cache; a redeploy can no longer lose
  data, because nothing authoritative was there.
- Two backends means two code paths to test; the driver contract test
  runs against both.

## Alternatives considered

- **Keep everything on the Altare app disk.** Rejected: a GitHub redeploy
  rebuilds from a clone, so runtime state can vanish; the acceptance
  criterion explicitly requires records to survive redeploys.
- **KV as the store.** Rejected as the primary store: no per-object
  listing semantics we can lean on for the audit sweep beyond a prefix
  list, and a 25 MiB value cap makes it a poor fit for snapshot bundles.
  KV remains available for future cache/lock use.
- **Postgres.** Rejected for this migration: it would replace the file
  format rather than preserve it, breaking the "existing data format is
  respected" requirement and forcing a data-model rewrite of the consent
  registry and audit log.
- **Mirror daemon (watch `data/`, push to U3 in the background).**
  Rejected: the write could lag the public `/anon` send, weakening the
  ADR-0003 durability guarantee; the audit path must be synchronous.
- **Monkey-patching `node:fs` to virtualise the data root.** Rejected:
  invisible global side effects on Discord.js and every dependency, and
  untestable in isolation.

## References

- `AGENTS.md`, `CLAUDE.md`
- `docs/process.md`, `docs/architecture.md`, `docs/quality.md`, `docs/security.md`, `docs/recovery.md`
- `docs/privacy.md`, `docs/adr/0003-anonymous-chat.md`
- `docs/operations/altare-migration.md` (cutover runbook)
- GitHub Issues: #121
- External: <https://docs.altare.gg/apps>, <https://docs.altare.gg/u3>,
  <https://docs.altare.gg/u3/connect>, <https://docs.altare.gg/kv>,
  <https://docs.altare.gg/platform/resources>
