#!/usr/bin/env bash
# Step 10.9 — Daily SQLite backup.
#
# Takes a consistent snapshot of the BrowserAI SQLite DB using the sqlite3
# `.backup` command (safe while the app is writing — uses the online backup
# API, not a raw file copy), gzips it, and prunes backups older than
# RETENTION_DAYS. Runs on the HOST via a systemd timer.
#
# Env:
#   DB_PATH         path to the live DB (default /opt/browserai-data/browserai.db)
#   BACKUP_DIR      output dir (default /opt/browserai-data/backups)
#   RETENTION_DAYS  how many days of backups to keep (default 14)
set -euo pipefail

DB_PATH="${DB_PATH:-/opt/browserai-data/browserai.db}"
BACKUP_DIR="${BACKUP_DIR:-/opt/browserai-data/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT="${BACKUP_DIR}/browserai-${STAMP}.db"
log() { echo "[backup $(date -u +%FT%TZ)] $*"; }

mkdir -p "$BACKUP_DIR"

if [ ! -f "$DB_PATH" ]; then
  log "ERROR: DB not found at $DB_PATH"
  exit 1
fi

# Prefer the online-backup API for a crash-consistent copy under load.
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB_PATH" ".backup '$OUT'"
else
  # Fallback: cp (less safe, but better than nothing if sqlite3 missing).
  cp "$DB_PATH" "$OUT"
fi

gzip -f "$OUT"
log "wrote ${OUT}.gz ($(du -h "${OUT}.gz" | cut -f1))"

# Integrity check on the freshest backup (decompress to a temp, run PRAGMA).
if command -v sqlite3 >/dev/null 2>&1; then
  tmp="$(mktemp)"
  gunzip -c "${OUT}.gz" > "$tmp"
  if sqlite3 "$tmp" "PRAGMA integrity_check;" | grep -q '^ok$'; then
    log "integrity_check: ok"
  else
    log "WARNING: integrity_check FAILED for ${OUT}.gz"
  fi
  rm -f "$tmp"
fi

# Prune old backups.
find "$BACKUP_DIR" -name 'browserai-*.db.gz' -type f -mtime "+${RETENTION_DAYS}" -print -delete \
  | sed 's/^/[backup] pruned /' || true

log "done (retention ${RETENTION_DAYS}d)"
