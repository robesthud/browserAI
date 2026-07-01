#!/usr/bin/env bash
# Step 10.2 — Zombie OpenHands runtime GC.
#
# OpenHands spins up one `openhands-runtime-<id>` container per active
# conversation. When a chat is abandoned the runtime can linger and each one
# holds ~1.4 GiB RAM — a few of them OOM the box. This script removes runtime
# containers that have been running longer than IDLE_MINUTES and are NOT the
# runtime backing a currently-active OpenHands conversation.
#
# Runs on the HOST (browserai container has no docker.sock). Idempotent; safe to
# run from a systemd timer. OpenHands recreates a runtime on the next request.
#
# Env:
#   IDLE_MINUTES   age threshold in minutes (default 45)
#   OH_URL         OpenHands base URL for the active-conversation check
#                  (default http://127.0.0.1:18000)
#   DRY_RUN=1      log what would be removed, don't remove
set -euo pipefail

IDLE_MINUTES="${IDLE_MINUTES:-45}"
OH_URL="${OH_URL:-http://127.0.0.1:18000}"
DRY_RUN="${DRY_RUN:-0}"
NOW="$(date +%s)"
log() { echo "[gc_runtimes $(date -u +%FT%TZ)] $*"; }

# Best-effort: collect conversation ids OpenHands still considers active, so we
# never kill a runtime that's mid-task. Failure here => we fall back to age-only.
ACTIVE_IDS=""
if command -v curl >/dev/null 2>&1; then
  ACTIVE_IDS="$(curl -fsS -m 5 "${OH_URL}/api/conversations" 2>/dev/null \
    | grep -oE '"conversation_id"[ ]*:[ ]*"[a-f0-9]+"' \
    | grep -oE '[a-f0-9]{8,}' || true)"
fi

removed=0
kept=0
for name in $(docker ps --format '{{.Names}}' | grep -E '^openhands-runtime-' || true); do
  # Container age in seconds.
  started_at="$(docker inspect -f '{{.State.StartedAt}}' "$name" 2>/dev/null || echo '')"
  [ -z "$started_at" ] && continue
  started_epoch="$(date -d "$started_at" +%s 2>/dev/null || echo "$NOW")"
  age_min=$(( (NOW - started_epoch) / 60 ))

  # Skip if younger than threshold.
  if [ "$age_min" -lt "$IDLE_MINUTES" ]; then
    kept=$((kept+1))
    continue
  fi

  # Skip if this runtime backs an active conversation.
  rid="${name#openhands-runtime-}"
  if [ -n "$ACTIVE_IDS" ] && echo "$ACTIVE_IDS" | grep -q "$rid"; then
    log "keep $name (age ${age_min}m, conversation still active)"
    kept=$((kept+1))
    continue
  fi

  if [ "$DRY_RUN" = "1" ]; then
    log "DRY_RUN would remove $name (age ${age_min}m)"
  else
    log "removing $name (age ${age_min}m, idle)"
    docker rm -f "$name" >/dev/null 2>&1 || log "failed to remove $name"
  fi
  removed=$((removed+1))
done

log "done: removed=${removed} kept=${kept} threshold=${IDLE_MINUTES}m"
