#!/usr/bin/env bash
# Snapshot DeepSeek session file once per run, keep the last 7 days.
# Intended to be invoked from cron / systemd timer on the deploy host.
#
# Usage:
#   ./scripts/backup-deepseek-session.sh                # uses DATA_DIR or ./data
#   DATA_DIR=/opt/browserai-data ./scripts/backup-deepseek-session.sh
#   BACKUP_DIR=/var/backups/browserai \
#     DATA_DIR=/opt/browserai-data \
#     ./scripts/backup-deepseek-session.sh
set -euo pipefail

DATA_DIR="${DATA_DIR:-/opt/browserai-data}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/browserai}"
KEEP_DAYS="${KEEP_DAYS:-7}"

SRC="${DATA_DIR}/deepseek_session.json"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${BACKUP_DIR}/deepseek_session.${STAMP}.json"

if [[ ! -f "$SRC" ]]; then
  echo "[backup] no session file at $SRC — nothing to do"
  exit 0
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# Atomic copy + restrict perms — file contains secrets.
cp -a "$SRC" "${DEST}.tmp"
chmod 600 "${DEST}.tmp"
mv "${DEST}.tmp" "$DEST"
echo "[backup] wrote $DEST"

# Rotation: drop snapshots older than KEEP_DAYS days.
find "$BACKUP_DIR" -name 'deepseek_session.*.json' -type f -mtime "+${KEEP_DAYS}" -print -delete \
  | sed 's/^/[backup] pruned /'
