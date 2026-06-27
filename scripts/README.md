# BrowserAI ops scripts (Step 10)

Host-level maintenance scripts. They run on the Docker **host** (not inside the
`browserai` container, which has no `docker.sock`).

| Script | Step | What it does |
|---|---|---|
| `gc_runtimes.sh` | 10.2 | Removes idle `openhands-runtime-*` containers (each ~1.4 GiB) older than `IDLE_MINUTES` that don't back an active conversation. |
| `backup.sh` | 10.9 | Crash-consistent SQLite `.backup` → gzip → integrity check → prune `RETENTION_DAYS`. |

## Install (on the server, `/opt/browserai`)

```bash
chmod +x /opt/browserai/scripts/*.sh

# systemd units
cp /opt/browserai/scripts/systemd/browserai-gc.service   /etc/systemd/system/
cp /opt/browserai/scripts/systemd/browserai-gc.timer     /etc/systemd/system/
cp /opt/browserai/scripts/systemd/browserai-backup.service /etc/systemd/system/
cp /opt/browserai/scripts/systemd/browserai-backup.timer   /etc/systemd/system/

systemctl daemon-reload
systemctl enable --now browserai-gc.timer browserai-backup.timer

# verify
systemctl list-timers | grep browserai
```

## Manual runs / debugging

```bash
# GC dry-run (lists what it would kill, removes nothing)
DRY_RUN=1 /opt/browserai/scripts/gc_runtimes.sh

# one-off backup
/opt/browserai/scripts/backup.sh

# inspect last service run
journalctl -u browserai-gc.service -n 50 --no-pager
journalctl -u browserai-backup.service -n 50 --no-pager
```

## Env knobs

* `gc_runtimes.sh`: `IDLE_MINUTES` (default 45), `OH_URL` (default
  `http://127.0.0.1:18000`), `DRY_RUN=1`.
* `backup.sh`: `DB_PATH` (default `/opt/browserai-data/browserai.db`),
  `BACKUP_DIR` (default `/opt/browserai-data/backups`), `RETENTION_DAYS`
  (default 14).
