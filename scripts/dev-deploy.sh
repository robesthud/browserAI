#!/usr/bin/env bash
# dev-deploy: push code changes to running container + git push.
#   Python — uvicorn --reload auto-picks up changes (0s)
#   UI     — rebuilds vite on host (~5s) + docker cp
set -euo pipefail
cd "$(dirname "$0")/.."

CHANGED_PY=$(git diff --name-only HEAD -- core/)
CHANGED_UI=$(git diff --name-only HEAD -- ui/src/)

if [ -n "$CHANGED_PY" ]; then
  echo "🐍 Python changes detected, copying to container..."
  docker cp core/. browserai:/app/core/
  echo "  uvicorn --reload will restart automatically"
fi

if [ -n "$CHANGED_UI" ]; then
  echo "🎨 UI changes detected, rebuilding..."
  (cd ui && npm run build)
  echo "  Copying dist to container..."
  docker cp ui/dist/. browserai:/app/ui/dist/
fi

if [ -z "$CHANGED_PY" ] && [ -z "$CHANGED_UI" ]; then
  echo "ℹ️  No Python or UI changes detected"
fi

echo "✅ Deployed"
