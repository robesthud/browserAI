#!/usr/bin/env bash
# Quick-deploy Python changes — just copy core/ to container.
# uvicorn --reload will auto-restart the server.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "📦 Copying core/ to container..."
docker cp core/. browserai:/app/core/

echo "✅ Done — uvicorn --reload will pick up changes automatically"
