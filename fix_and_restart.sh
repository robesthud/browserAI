#!/bin/bash
# ============================================
# BrowserAI Fix & Restart Script
# Исправляет типичные проблемы и перезапускает
# ============================================

set -e
cd /root/browserai 2>/dev/null || cd "$(dirname "$0")"

echo "🔧 BrowserAI Fix & Restart"
echo ""

# 1. Ensure directories exist
mkdir -p data bridge_config

# 2. Fix docker-compose.yml — use the optimized version
cat > docker-compose.yml << 'COMPOSEEOF'
services:
  browserai:
    image: node:20-bookworm
    container_name: browserai
    restart: always
    ports:
      - "8787:8787"
    environment:
      - PORT=8787
      - NODE_ENV=production
      - AUTH_SECRET=3eb892f1280bb68bae21012166c639851debe32ae460c890c2a766110068d34e
      - BROWSERAI_DB=/data/browserai.db
      - WORKSPACE_ROOT=/data/workspace
      - BRIDGE_CONFIG_PATH=/bridge_config/config.json
    volumes:
      - ./data:/data
      - ./bridge_config:/bridge_config
      - browserai_app:/app
    command: >
      sh -c "
        if [ ! -f /app/package.json ]; then
          echo '📦 Cloning BrowserAI...';
          rm -rf /app/* /app/.* 2>/dev/null || true;
          git clone https://github.com/robesthud/browserAI.git /tmp/browserai_clone;
          cp -a /tmp/browserai_clone/. /app/;
          rm -rf /tmp/browserai_clone;
        fi &&
        cd /app &&
        echo '📦 Installing dependencies...' &&
        npm install 2>&1 | tail -5 &&
        echo '🔨 Building frontend...' &&
        npm run build 2>&1 | tail -5 &&
        echo '🚀 Starting BrowserAI on port 8787...' &&
        npm start
      "
    working_dir: /app

  bridge:
    image: python:3.10-slim
    container_name: lmarena-bridge
    restart: always
    ports:
      - "8000:8000"
    volumes:
      - ./bridge_config:/config_dir
      - bridge_app:/app
    environment:
      - CONFIG_FILE=/config_dir/config.json
      - MODELS_FILE=/config_dir/models.json
      - PORT=8000
      - DEBUG=1
    command: >
      sh -c "
        if [ ! -f /app/requirements.txt ]; then
          echo '📦 Installing system deps...';
          apt-get update &&
          apt-get install -y --no-install-recommends
            git curl libgtk-3-0 libasound2 libnss3 libx11-xcb1
            libxcomposite1 libxcursor1 libxdamage1 libxext6
            libxfixes3 libxi6 libxrender1 libxtst6 libglib2.0-0
            libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libgcc-s1
            libc6 libdbus-1-3 libxcb1 libxkbcommon0 libgbm1
            libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxt6
            libdbus-glib-1-2 libpci3 libegl1 libopus0 libevent-2.1-7
            ca-certificates &&
          rm -rf /var/lib/apt/lists/* &&
          echo '📦 Cloning LMArenaBridge...';
          git clone https://github.com/CloudWaddie/LMArenaBridge.git /tmp/bridge_clone;
          cp -a /tmp/bridge_clone/. /app/;
          rm -rf /tmp/bridge_clone;
          cd /app &&
          pip install --no-cache-dir -r requirements.txt &&
          playwright install firefox &&
          playwright install-deps firefox;
        fi &&
        cd /app &&
        echo '🚀 Starting LMArenaBridge on port 8000...' &&
        python3 -m src.main
      "
    working_dir: /app

volumes:
  browserai_app:
  bridge_app:
COMPOSEEOF

echo "✅ docker-compose.yml updated"

# 3. Ensure config.json exists
if [ ! -f bridge_config/config.json ]; then
    cat > bridge_config/config.json << 'CONFIGEOF'
{
    "password": "admin",
    "auth_token": "",
    "auth_tokens": [],
    "cf_clearance": "",
    "api_keys": [
        {
            "name": "BrowserAI Key",
            "key": "sk-lmab-browserai-default",
            "rpm": 60,
            "created": 1717545600
        }
    ],
    "usage_stats": {},
    "prune_invalid_tokens": false,
    "persist_arena_auth_cookie": true,
    "camoufox_proxy_window_mode": "headless",
    "camoufox_fetch_window_mode": "headless",
    "chrome_fetch_window_mode": "headless"
}
CONFIGEOF
    echo "✅ config.json created"
fi

if [ ! -f bridge_config/models.json ]; then
    echo "[]" > bridge_config/models.json
    echo "✅ models.json created"
fi

# 4. Stop & rebuild
echo ""
echo "🛑 Stopping containers..."
docker compose down --remove-orphans 2>/dev/null || docker-compose down --remove-orphans 2>/dev/null || true

echo ""
echo "🚀 Starting containers..."
docker compose up -d 2>/dev/null || docker-compose up -d

echo ""
echo "📊 Container status:"
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo ""
echo "⏳ Waiting 30 seconds for initial startup..."
sleep 30

# 5. Quick health check
echo ""
echo "🏥 Health checks:"
HTTP_BROWSERAI=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8787/api/health 2>/dev/null || echo "000")
HTTP_BRIDGE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/api/v1/health 2>/dev/null || echo "000")

if [ "$HTTP_BROWSERAI" = "200" ]; then
    echo "  ✅ BrowserAI (8787): OK"
else
    echo "  ❌ BrowserAI (8787): HTTP $HTTP_BROWSERAI (still starting? check: docker logs browserai)"
fi

if [ "$HTTP_BRIDGE" = "200" ]; then
    echo "  ✅ Bridge (8000): OK"
else
    echo "  ❌ Bridge (8000): HTTP $HTTP_BRIDGE (still starting? check: docker logs lmarena-bridge)"
fi

echo ""
echo "📋 Quick logs:"
echo "--- BrowserAI (last 10 lines) ---"
docker logs browserai --tail 10 2>&1
echo ""
echo "--- Bridge (last 10 lines) ---"
docker logs lmarena-bridge --tail 10 2>&1
echo ""
echo "=========================================="
echo "Done! If services are still starting, wait 1-2 min then check:"
echo "  docker logs -f browserai"
echo "  docker logs -f lmarena-bridge"
echo "=========================================="
