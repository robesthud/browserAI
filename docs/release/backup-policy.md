# Backup Policy — Approach 7

BrowserAI keeps state on disk in `/opt/browserai/data` and
`/opt/browserai/workspace`. Both must survive deploys, restarts, and
disasters.

## What is backed up

| Path | Contents | Backup cadence |
|---|---|---|
| `/data/browserai.db` | SQLite: users, chats, messages, settings, jobs, incidents, ops state | Hourly snapshot + pre-deploy |
| `/data/runs/` | Per-run structured logs (`browserai.run_log.v1`) | Daily snapshot, retained 30d |
| `/data/replays/` | Replay artifacts (`browserai.replay.v1`) | Daily snapshot, retained 30d |
| `/data/deepseek_session.json` | Bearer + cookies for managed DeepSeek session | Hourly snapshot, encrypted at rest |
| `/data/backups/` | Existing auto-backups (from `server/backup.js`) | Pre-deploy snapshot |
| `/opt/browserai/workspace/chats/<chatId>/` | Per-chat workspace files (git checkouts, edits) | Daily snapshot, retained 14d |

## What is NOT backed up

- `/data/chat-debug.log` — high-volume, debug-only
- `/data/client-errors.log` — high-volume, debug-only
- `/data/errors.log` — rotated daily inside container
- Docker images — rebuilt on demand
- `node_modules` — re-installed on `docker compose build`

## Backup destinations

Primary: local `/data/backups/` (fastest recovery, same host).
Secondary: Timeweb Object Storage (off-host, requires manual setup).

To enable Timeweb Object Storage backups:

1. Create bucket `browserai-backups` in Timeweb Object Storage
2. Generate access keys (Settings → API keys)
3. Set env vars in `.env`:
   ```
   S3_ENDPOINT=https://s3.twcstorage.ru
   S3_BUCKET=browserai-backups
   S3_ACCESS_KEY=<your_access_key>
   S3_SECRET_KEY=<your_secret_key>
   S3_REGION=ru-1
   ```
4. Enable cron: `scripts/backup-to-s3.sh` (to be added)

## Restore procedure

### Local restore (same host)

```bash
# List available backups
ls -la /data/backups/

# Stop the service
docker stop browserai

# Restore SQLite
cp /data/backups/browserai-YYYYMMDD-HHMM.db /data/browserai.db

# Restore runs + replays (selective)
rsync -av /data/backups/runs-YYYYMMDD-HHMM/ /data/runs/
rsync -av /data/backups/replays-YYYYMMDD-HHMM/ /data/replays/

# Restart
docker start browserai

# Verify
curl -fsS http://127.0.0.1:8080/api/health
```

### Off-host restore (Timeweb S3)

```bash
# Install s3cmd or aws-cli
pip install awscli
aws configure  # paste the access_key and secret_key

# Pull latest backup
aws --endpoint-url https://s3.twcstorage.ru s3 sync s3://browserai-backups/db/ /data/
aws --endpoint-url https://s3.twcstorage.ru s3 sync s3://browserai-backups/runs/ /data/runs/
aws --endpoint-url https://s3.twcstorage.ru s3 sync s3://browserai-backups/replays/ /data/replays/

# Restart
docker restart browserai
```

## Retention

- SQLite: 30 daily snapshots + 12 monthly
- Runs/replays: 30 days
- Workspace files: 14 days
- Pre-deploy snapshots: kept until next deploy (1-2 weeks typical)

## Disaster recovery targets

- **RTO** (recovery time objective): 15 minutes for local, 60 minutes for
  off-host
- **RPO** (recovery point objective): 1 hour for SQLite (hourly snapshots),
  24 hours for runs/replays (daily snapshots)

## Verification

Once per month, run a backup-restore drill:

1. Pick the oldest backup in `/data/backups/`
2. Restore it to a temporary SQLite path
3. Verify with `sqlite3 /tmp/restored.db "SELECT COUNT(*) FROM users"` —
   should match the expected user count
4. Verify a sample run replay: `loadReplay(<runId>)` should return
   non-null JSON with `schema === 'browserai.replay.v1'`
5. Document the drill result in the postmortem log
