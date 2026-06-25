#!/bin/bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/browserai}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
REBUILD_AGENT_SANDBOX="${REBUILD_AGENT_SANDBOX:-0}"
PRE_PRUNE_THRESHOLD="${PRE_PRUNE_THRESHOLD:-80}"

cd "$APP_DIR"
echo "=== BrowserAI Deploy (${DEPLOY_BRANCH}) ==="

echo "Pulling latest code..."
rm -f .git/index.lock ".git/refs/remotes/origin/${DEPLOY_BRANCH}.lock" 2>/dev/null || true
git fetch origin "$DEPLOY_BRANCH"
git sparse-checkout disable 2>/dev/null || true
git reset --hard "origin/${DEPLOY_BRANCH}"
git clean -fd
git log -1 --oneline

DISK_USED_PCT=$(df --output=pcent / | tail -1 | tr -dc '0-9' || echo 0)
echo "Disk usage before build: ${DISK_USED_PCT}%"
if [ "${DISK_USED_PCT}" -ge "${PRE_PRUNE_THRESHOLD}" ]; then
  echo "Pruning Docker build cache/images before build..."
  docker builder prune -af >/dev/null 2>&1 || true
  docker image prune -f >/dev/null 2>&1 || true
fi

echo "Ensuring base services are up..."
docker compose up -d --no-build db ollama >/dev/null 2>&1 || true

if [ "$REBUILD_AGENT_SANDBOX" = "1" ]; then
  echo "Rebuilding agent-sandbox image..."
  docker compose build agent-sandbox
else
  echo "Skipping agent-sandbox rebuild"
fi

# Pre-deploy smoke suite (fast — only runs if providers configured)
echo "Running pre-deploy smoke suite..."
bash scripts/pre-deploy-smoke.sh || echo "Pre-deploy smoke completed with warnings (non-blocking)."

echo "Building browserai image..."
docker compose build browserai

echo "Removing stale compose replacement containers..."
# Compose v2/v5 can leave replacement containers around when a previous
# deployment is interrupted. Remove both compose-known and raw-name containers
# before recreate, then retry once on a name conflict.
docker compose rm -sf browserai agent-sandbox >/dev/null 2>&1 || true
docker rm -f browserai agent-sandbox 2>/dev/null || true
docker ps -a --format '{{.Names}}' | grep -E '(^|_)(browserai|agent-sandbox)$' | xargs -r docker rm -f 2>/dev/null || true

compose_up_retry() {
  local service="$1"; shift
  if docker compose up -d "$@" "$service"; then return 0; fi
  echo "Compose recreate for ${service} failed once; cleaning stale containers and retrying..."
  docker compose rm -sf "$service" >/dev/null 2>&1 || true
  docker rm -f "$service" 2>/dev/null || true
  docker ps -a --format '{{.Names}}' | grep -E "(^|_)${service}$" | xargs -r docker rm -f 2>/dev/null || true
  docker compose up -d "$@" "$service"
}

if [ "$REBUILD_AGENT_SANDBOX" = "1" ]; then
  echo "Recreating agent-sandbox..."
  compose_up_retry agent-sandbox --no-build --force-recreate
else
  echo "Ensuring agent-sandbox container exists..."
  docker compose up -d --no-build agent-sandbox >/dev/null 2>&1 || true
fi

echo "Recreating browserai..."
compose_up_retry browserai --no-build --no-deps --force-recreate

echo "Waiting for health..."
for i in $(seq 1 40); do
  if curl -fsS http://127.0.0.1/api/health >/dev/null 2>&1; then
    echo "Health OK"
    docker ps --format '{{.Names}} {{.Status}} {{.Ports}}' | grep -E 'browserai|agent-sandbox|browserai-db|browserai-ollama' || true
    echo "Pruning old Docker build cache..."
    docker builder prune -af --filter 'until=24h' >/dev/null 2>&1 || true
    echo "=== Deploy completed ==="
    exit 0
  fi
  echo "health not ready ($i/40)"
  sleep 2
done

echo "Health check failed; recent logs:"
docker ps -a --format '{{.Names}} {{.Status}} {{.Ports}}' | grep -E 'browserai|agent-sandbox|browserai-db|browserai-ollama' || true
docker logs --tail=120 browserai 2>&1 || true
exit 1
