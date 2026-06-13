#!/bin/bash
set -euo pipefail

echo "=== BrowserAI Deploy ==="
cd /opt/browserai

echo "Pulling latest code..."
git fetch origin main
git reset --hard origin/main
git log -1 --oneline

echo "Building docker image..."
docker compose build browserai

echo "Removing stale compose replacement containers..."
docker rm -f browserai agent-sandbox 2>/dev/null || true
docker ps -a --format '{{.Names}}' | grep -E '^[0-9a-f]+_browserai$' | xargs -r docker rm -f 2>/dev/null || true

echo "Restarting services..."
docker compose up -d --remove-orphans browserai agent-sandbox

echo "Waiting for health..."
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1/api/health >/dev/null 2>&1; then
    echo "Health OK"
    docker ps --format '{{.Names}} {{.Status}} {{.Ports}}' | grep -E 'browserai|agent-sandbox'
    echo "Pruning old Docker build cache..."
    docker builder prune -af --filter 'until=24h' >/dev/null 2>&1 || true
    echo "=== Deploy completed ==="
    exit 0
  fi
  echo "health not ready ($i/30)"
  sleep 2
done

echo "Health check failed; recent logs:"
docker logs --tail=120 browserai 2>&1 || true
exit 1
