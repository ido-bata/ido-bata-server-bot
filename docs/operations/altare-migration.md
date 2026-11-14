# Altare migration runbook

Operational procedure for moving `ido-bata-server-bot` from the current
host to Altare's free hosting, and for operating it afterwards.

Authoritative decisions: [`docs/adr/0004-altare-migration-u3-persistence.md`](../adr/0004-altare-migration-u3-persistence.md).
Related: [`docs/architecture.md`](../architecture.md), [`docs/privacy.md`](../privacy.md),
[`docs/process.md`](../process.md).

## 0. What changes

| Concern | Before | After (Altare) |
| --- | --- | --- |
| Runtime | Windows host, `bun run start` (tsx) | Altare app, `node dist/index.js` |
| Persistence | files under `data/` | U3 bucket (S3-compatible), `STORAGE_BACKEND=u3` |
| App disk | authoritative | cache only — a redeploy may wipe it |
| Secrets | `.env` on the host | Altare app variables |
| Single instance | assumed | storage lease in a backend **both hosts share** — Altare Valkey (`LEASE_STORAGE_BACKEND=valkey`), because U3 ignores S3 conditional writes |

The storage *layout* does not change: `data/consent.json` becomes the
object `consent.json`, `data/anon-audit/<file>` becomes
`anon-audit/<file>`, and so on.

## 1. Inventory (before the move)

```sh
bun run storage:migrate -- export --source local --source-dir ./data --out ./migration-export
```

`--source local` reads the old host's `data/` directory. Without it the
export reads the **configured backend** — that is what the daily backup
of a bucket needs.

The export contains every object of the local `data/` directory plus
`manifest.json` (per-object size + sha256). Keep the export directory:
it is the rollback material.

Record the inventory in the Issue:

```sh
cat ./migration-export/manifest.json
```

## 2. Provision the bucket

1. Altare console → **Storage → U3 → Create bucket** (name: `ido-bata-bot`,
   location: the region closest to the bot, e.g. `eu`).
2. **Connect to app** → pick the app → access *Read and write*. Altare
   injects `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE`,
   `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and redeploys the app.
   Never copy these values into git, an Issue, a PR, or a log.
3. Keep a **second** bucket for backups (same region, different name).

## 3. Configure the app

Altare → app → **Deployments → Settings**:

| Setting | Value |
| --- | --- |
| Install command | `bun install --frozen-lockfile` |
| Build command | `bun run build` |
| Start command | `node dist/index.js` |
| Health check path | `/health` (liveness); `/ready` returns 503 until the storage lease is held and the gateway is connected |
| Node runtime | 22 (matches `engines.node`) |

App variables (Settings → Variables):

| Variable | Value | Notes |
| --- | --- | --- |
| `DISCORD_TOKEN` | secret | rotate at cutover (see §6) |
| `DISCORD_CLIENT_ID` | secret | |
| `DISCORD_GUILD_ID` | id | |
| `CONSENT_CHANNEL_ID` | id | enables the consent registry |
| `HEALTH_PORT` | `8080` | must match the app's exposed port |
| `HEALTH_HOST` | `0.0.0.0` | the health endpoint must be reachable from outside |
| `STORAGE_BACKEND` | `u3` | selects the object store |
| `LEASE_STORAGE_BACKEND` | `valkey` | the lease backend — U3 cannot hold an exclusive lease (no conditional writes); attach a Valkey instance to inject `REDIS_URL` |
| `DELETION_LEDGER_KEY` | secret (≥16 bytes) | HMAC key for the deletion ledger; without it a restore of an old backup can resurrect deleted data |
| `ANON_AUDIT_PUBLIC_KEY` | PEM | only the **public** key; the private key never leaves the custodian's store |
| `BOT_TUI` | `off` | headless host: the structured logger keeps writing JSON Lines |

`S3_*` / `AWS_*` are injected by the U3 connection — do not set them by hand.

## 4. Migrate the data

From the **old host** (or any machine that can reach the bucket) with the
bucket credentials in the environment:

```sh
export STORAGE_BACKEND=u3
export S3_ENDPOINT=https://u3-eu.altare.global
export S3_REGION=eu
export S3_BUCKET=ido-bata-bot
export AWS_ACCESS_KEY_ID=...      # from the Altare console — never commit
export AWS_SECRET_ACCESS_KEY=...

bun run storage:migrate -- import --from ./migration-export
bun run storage:migrate -- verify --from ./migration-export
```

`verify` prints `verified / missing / mismatched / unexpected` counts and
exits non-zero on any difference. Repeat until it reports zero missing and
zero mismatched objects.

The old host's `data/` directory is **not** touched by these commands —
keep it until the cutover is signed off.

## 5. Cutover

The order matters: **stop the old host → freeze the final data → switch
the token → start the new host.** Each step removes one way to run two
instances or to lose a record.

### 5.0 Prepare the old host (before the cutover)

Deploy the migration build to the old host and point its **lease** at the
shared bucket while its data stays local:

```sh
# old host
export STORAGE_BACKEND=local          # data still on the local disk
export LEASE_STORAGE_BACKEND=valkey   # the lease is shared with Altare
export REDIS_URL=...                  # the shared Valkey instance
bun run start
```

From this moment the old host and the Altare deployment contend for the
same lease object: the Altare instance refuses to start while the old
host holds it.

### 5.1 Stop the old bot

```sh
# SIGTERM → the shutdown handler expires the lease
```

The lease term is expired (not deleted), so the next instance can take it
over immediately. If the host crashed, wait for the term to expire
(60 s) or remove the `locks/instance.json` object by hand.

### 5.2 Freeze the final data

The old bot is stopped, so no further writes happen. Export the final
state and import it into the bucket:

```sh
# old host — the data still lives on the local disk
bun run storage:migrate -- export --source local --source-dir ./data --out ./migration-final

export STORAGE_BACKEND=u3 S3_ENDPOINT=... S3_REGION=... S3_BUCKET=ido-bata-bot \
       AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
export DELETION_LEDGER_KEY=...          # required: the restore refuses without it
bun run storage:migrate -- import --from ./migration-final
bun run storage:migrate -- verify --from ./migration-final
```

`verify` must report zero missing and zero mismatched objects. Keep
`./migration-final` — it is the rollback material.

### 5.3 Switch the Discord token

Rotate the token in the Discord Developer Portal and update the Altare
variable. The old host's copy is then useless: even if it comes back to
life it cannot log in.

### 5.4 Start the new host

```sh
# Altare: push to the linked branch or press Deploy
```

Watch the logs: `storage lease acquired` (with the epoch), then
`Logged in as …`, then the consent reconciler on `ClientReady`. If the
lease is still held by the old host, the instance refuses to start with
`another bot instance holds the storage lease` — that is the intended
behaviour, not a failure to fix.

### 5.5 Verify in Discord

- `/privacy status` shows the grants that were migrated (the consent
  registry is read from U3 now).
- a `/anon` post writes an audit record (`anon-audit/` objects appear in
  the bucket) — the post is refused when the audit write fails.
- `/privacy delete` removes the user-keyed records, reports the honest
  outcome for the audit log, and writes the deletion ledger entry.
- the timekeeper session joins the stage channel (voice egress — see §9).

## 6. Double-run protection

The bot takes a lease (`locks/instance.json`) in the **lease backend**
before it connects to Discord:

- a second instance refuses to start (`LeaseConflictError`) — verified
  live against Altare Valkey: `SET NX` + a Lua compare-and-swap give real
  exclusivity (U3 was probed first and ignores `If-None-Match`/`If-Match`,
  so it cannot hold the lease — ADR-0004 §10);
- every lease mutation is a compare-and-swap against the version the
  holder read, so a takeover cannot be lost in a read-then-write window;
- releasing *expires* the term instead of deleting the object, so a
  release can never remove a term another instance just acquired;
- the holder renews the term every 20 s; a term that cannot be renewed
  (backend down, taken over) shuts the bot down with exit code 1 — the
  bot never keeps running unowned;
- the term expires 60 s after the holder stops, so a crashed host does
  not block the replacement forever.

The lease is only as exclusive as the backend. The bot probes the backend
at startup (`probeConditionalWrites`); a backend that does not enforce
conditional writes stops the bot. On Altare the lease backend is Valkey —
create it once and attach it to the app (`altr valkey create`, then
`altr valkey attach <instance> "<app>"`, which injects `REDIS_URL` and
redeploys). The instance's `rediss://` endpoint serves a self-signed
certificate: download it from the instance page ("Download certificate")
and set `VALKEY_TLS_CA` (PEM inline, `
` escapes allowed) so chain and
hostname verification stay enabled. `VALKEY_TLS_INSECURE=true` is the
explicit last-resort opt-out; without a CA the connection fails closed:

```text
the storage backend does not support conditional writes; the instance lease cannot be exclusive
```

`LEASE_ALLOW_UNCONDITIONAL=true` overrides that, but only after the
backend's behaviour was verified by hand (§7.2).

A refused or lost lease now exits the process non-zero
(`LEASE_REFUSED` / `LEASE_LOST`) instead of lingering on the health port,
and `/ready` reports 503 until the lease is held — a redeploy overlap is
absorbed by the startup retry (lease TTL + margin) and then proceeds.

**Never run two instances deliberately.** The lease is a safety net, not
an orchestrator.

## 7. Backup and restore

### 7.1 The procedure (one command, repeatable)

The primary bucket is the source of truth. A backup is a copy of it in a
second bucket:

```sh
export S3_BUCKET=ido-bata-bot                 # the bucket to copy FROM
export BACKUP_AWS_ACCESS_KEY_ID=...          # the backup bucket has its own key
export BACKUP_AWS_SECRET_ACCESS_KEY=...
export DELETION_LEDGER_KEY=...               # required: the restore refuses without it

bun run storage:migrate -- backup \
  --target-bucket ido-bata-bot-backup \
  --out ./backups/$(date +%F-%H%M)
```

The command copies the primary bucket into `--target-bucket` **and
verifies that same bucket** — the verification cannot drift to another
bucket because the target is part of the command. The copy overwrites the
previous one, so a daily backup is repeatable; only the export directory
has to be new (`--out` with a timestamp).

U3 access keys are scoped per bucket, so the backup bucket needs its own
key (`BACKUP_AWS_ACCESS_KEY_ID` / `BACKUP_AWS_SECRET_ACCESS_KEY`). On
Altare attach it with a dedicated prefix so the primary key is untouched:

```sh
altr u3 attach ido-bata-bot-backup "<app>" --prefix BACKUP_AWS
# injects BACKUP_AWS_ENDPOINT / _REGION / _BUCKET / _ACCESS_KEY_ID / _SECRET_ACCESS_KEY
```

Schedule it with cron on a host that holds the credentials:

```cron
# 03:17 daily — copy the primary bucket into the backup bucket and verify
17 3 * * * cd /srv/ido-bata && set -a && . /srv/ido-bata/backup.env && set +a && \
  bun run storage:migrate -- backup --target-bucket ido-bata-bot-backup \
  --out ./backups/$(date +\%F-\%H\%M)
```

`backup.env` holds the credentials (chmod 600, owned by the bot user).
The job must fail loudly: a backup that cannot be verified is not a
backup.

### 7.2 Restore drill (run it before you need it)

```sh
# export the backup bucket
export S3_BUCKET=ido-bata-bot-backup
bun run storage:migrate -- export --out ./restore-drill

# import it into an empty bucket and verify
export S3_BUCKET=ido-bata-bot-restore-test
bun run storage:migrate -- import --from ./restore-drill
bun run storage:migrate -- verify --from ./restore-drill
```

The same drill runs as a regression test
(`tests/storage-backup-restore.test.ts`, `tests/storage-tooling-review.test.ts`),
but the *real* bucket must be drilled once — the mock only proves the
code path, not the backend.

### 7.3 Restoring over a live store

A restore writes the objects of the export into the target bucket. The
deletion ledger is **merged**, never replaced (§7.4), and the recorded
erasures are re-applied to the restored objects. The verification then
compares the **post-erasure** state: an object that differs from the
backup only because a deletion was re-applied is reported as correct, not
as a checksum mismatch.

### 7.4 The deletion ledger

`privacy/deletions.json` records that a subject's data was erased. It
holds an HMAC-SHA256 digest of the subject id, not the id itself.

- `DELETION_LEDGER_KEY` must be configured **before** the first
  `/privacy delete`, and the key must be kept in the secret manager.
- Without the key the restore **refuses** (`DELETION_LEDGER_KEY is not
  configured; refusing to restore data that may contain deleted
  subjects`). `--allow-missing-deletion-ledger` overrides it explicitly.
- A **corrupt** ledger aborts the restore; it is never read as "no
  deletions happened".
- With the key, a restore re-applies every recorded erasure, so the
  deleted subject does not come back even from an old backup.

### 7.5 State snapshots

State-snapshot bundles (`snapshots/` objects) are AES-256-GCM encrypted;
restoring them needs `STATE_SNAPSHOT_ENCRYPTION_KEY`:

```sh
bun run restore:state -- --snapshot snapshots/20260401-030000.snap.enc
```

## 8. Routine operations

| Task | Command / place |
| --- | --- |
| Inspect the bucket | Altare console → Storage → U3 → your bucket |
| Export a bucket | `bun run storage:migrate -- export --out ./export-<stamp>` |
| Verify a bucket | `bun run storage:migrate -- verify --from ./export-<stamp>` |
| Audit-key custodian lookup | `bun run anon:audit:lookup -- --key-file <private.pem> --dir anon-audit --message <id>` |
| Audit-key custodian delete | `bun run anon:audit:delete -- --key-file <private.pem> --dir anon-audit --user <id>` |
| Restore a state snapshot | `bun run restore:state -- --snapshot <key>` |
| Check the deletion ledger | `altr u3 ls` the bucket, or export and read `privacy/deletions.json` |
| Prove the backend enforces conditions | start the bot once with `STORAGE_BACKEND=u3` and look for the absence of the "does not support conditional writes" error, then run the drill in §7.2 |
| Redeploy | push to the linked branch, or press *Deploy* — the data is unaffected |

The custodian commands run **offline** with the RSA private key. They
operate on the configured storage backend, so they need the bucket
credentials in the environment.

## 9. Known constraints

- **Voice (stage channel)**: the timekeeper joins a Discord voice channel.
  Altare apps must be able to reach Discord's voice servers over UDP; if
  the region blocks it, the session fails while the rest of the bot keeps
  running. Verify with a real session right after the cutover.
- **App disk is a cache**: never point a feature at a file under the app's
  local disk as the only copy of user data. Everything under `data/` now
  goes through the storage port.
- **Region pinning**: U3 buckets are pinned to a region; the app and the
  bucket should live in the same region to keep the round-trip short.
- **A mock is not a proof of the backend**: the contract tests run against
  an in-process S3-compatible mock. Two things must be kept apart:
  - *"the bot started"* proves only that the configuration is readable and
    the probe passed. It does **not** prove exclusivity.
  - *"exclusivity holds"* is shown by the startup probe
    (`probeConditionalWrites` — a backend that does not enforce
    conditional writes makes the bot refuse to start) **and** by the
    drill in §7.2 against the real bucket. Both are environment-dependent
    and are not covered by this repository's tests.
- **Always Free limits**: 10 GB storage, 5 buckets, 3 million reads and
  300 000 writes per month for KV (unused by the bot), 4 servers per team.
  The bot's write volume (a grant, an attendance day, an audit record) is
  far below that.
