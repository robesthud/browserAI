#!/bin/bash
set -e

echo "=== BrowserAI Deploy ==="
cd /opt/browserai

echo "Pulling latest code..."
git pull origin main

echo "Building docker images..."
docker compose build --no-cache browserai

echo "Restarting services..."
docker compose up -d --force-recreate browserai agent-sandbox

echo "Waiting for health..."
sleep 8
docker ps | grep browserai

echo "=== Deploy completed ==="
