#!/usr/bin/env bash
# Quick-deploy UI changes without Docker rebuild.
# Rebuilds vite on the host (~5s) and copies into the running container.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "🔨 Building UI..."
(cd ui && npm run build)

echo "📦 Copying to container..."
docker cp ui/dist/. browserai:/app/ui/dist/

echo "✅ Done — UI updated in ~5s, no rebuild needed"
