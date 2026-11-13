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
| Single instance | assumed | storage lease (`locks/instance.json`) |

The storage *layout* does not change: `data/consent.json` becomes the
object `consent.json`, `data/anon-audit/<file>` becomes
`anon-audit/<file>`, and so on.

## 1. Inventory (before the move)

```sh
bun run storage:migrate -- export --out ./migration-export
```

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
| Health check path | `/health` |
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

1. Stop the old bot (SIGTERM → the shutdown handler releases the storage
   lease).
2. Confirm the lease is gone or expired: the new instance refuses to start
   while a live lease exists (`another bot instance holds the storage
   lease`).
3. Deploy the new branch to Altare (push to the branch the app is linked
   to, or press *Deploy* in the console).
4. Watch the logs: `storage lease acquired`, `Logged in as …`, and the
   consent reconciler running on `ClientReady`.
5. Verify in Discord:
   - `/privacy status` shows the grants that were migrated (the consent
     registry is read from U3 now).
   - a `/anon` post writes an audit record (`anon-audit/` objects appear
     in the bucket) — the post is refused when the audit write fails.
   - `/privacy delete` removes the user-keyed records and reports the
     honest outcome for the audit log.
6. Rotate `DISCORD_TOKEN` in the Discord Developer Portal and update the
   Altare variable (the old host's copy is then useless).

## 6. Double-run protection

The bot takes a lease (`locks/instance.json`) in the storage backend
before it connects to Discord:

- a second instance refuses to start (`LeaseConflictError`) — the old host
  and the Altare deployment can never process the same event twice;
- the holder renews the lease every 20 s; a lease that cannot be renewed
  (backend down, taken over) is reported and the instance shuts down;
- the lease expires 60 s after the holder stops, so a crashed host does
  not block the replacement forever.

**Never run two instances deliberately.** The lease is a safety net, not
an orchestrator.

## 7. Backup and restore

Backup = a copy of the bucket. Altare does not schedule bucket copies, so
use one of:

- **U3 lifecycle** on a second bucket: not a copy, but a retention rule.
- **Altare CLI / console**: copy the bucket objects into
  `ido-bata-bot-backup` on a schedule (cron on any host with the bucket
  credentials).
- **Altare app Backups**: copies the *app files*, not the bucket — useful
  for code, not for data.

Recommended: a daily copy into the backup bucket plus a weekly
`storage:migrate -- export` into cold storage.

Restore:

```sh
STORAGE_BACKEND=u3 … bun run storage:migrate -- import --from ./migration-export --allow-overwrite
STORAGE_BACKEND=u3 … bun run storage:migrate -- verify --from ./migration-export
```

State-snapshot bundles (`snapshots/` objects) are AES-256-GCM encrypted;
restoring them needs `STATE_SNAPSHOT_ENCRYPTION_KEY`
(`bun run restore:state -- --snapshot <key>`).

## 8. Routine operations

| Task | Command / place |
| --- | --- |
| Inspect the bucket | Altare console → Storage → U3 → your bucket |
| Export a backup | `bun run storage:migrate -- export --out ./backup-$(date +%F)` |
| Verify the bucket | `bun run storage:migrate -- verify --from ./backup-$(date +%F)` |
| Audit-key custodian lookup | `bun run anon:audit:lookup -- --key-file <private.pem> --dir anon-audit --message <id>` |
| Audit-key custodian delete | `bun run anon:audit:delete -- --key-file <private.pem> --dir anon-audit --user <id>` |
| Restore a state snapshot | `bun run restore:state -- --snapshot <key>` |
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
- **Always Free limits**: 10 GB storage, 5 buckets, 3 million reads and
  300 000 writes per month for KV (unused by the bot), 4 servers per team.
  The bot's write volume (a grant, an attendance day, an audit record) is
  far below that.
