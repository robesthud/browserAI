#!/bin/bash
# ============================================
# BrowserAI + LMArenaBridge Server Setup Script
# Запустите на сервере Timeweb:
#   cd /root && bash setup_server.sh
# ============================================

set -e

PROJECT_DIR="/root/browserai"
REPO_URL="https://github.com/robesthud/browserAI.git"

echo "=========================================="
echo "🚀 BrowserAI + Bridge Setup Script"
echo "=========================================="

# 1. Clone or update the repo
if [ -d "$PROJECT_DIR/.git" ]; then
    echo "📦 Updating existing project..."
    cd "$PROJECT_DIR"
    git pull --ff-only 2>/dev/null || echo "⚠️ Git pull failed, using existing code"
else
    echo "📦 Cloning project..."
    git clone "$REPO_URL" "$PROJECT_DIR"
    cd "$PROJECT_DIR"
fi

# 2. Create directories
echo "📁 Creating directories..."
mkdir -p "$PROJECT_DIR/data"
mkdir -p "$PROJECT_DIR/bridge_config"

# 3. Create bridge config if not exists
if [ ! -f "$PROJECT_DIR/bridge_config/config.json" ]; then
    echo "📝 Creating bridge config..."
    cat > "$PROJECT_DIR/bridge_config/config.json" << 'CONFIGEOF'
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
    echo "✅ Bridge config created"
else
    echo "✅ Bridge config already exists"
fi

# Create models.json if not exists
if [ ! -f "$PROJECT_DIR/bridge_config/models.json" ]; then
    echo "[]" > "$PROJECT_DIR/bridge_config/models.json"
fi

# 4. Stop existing containers
echo "🛑 Stopping existing containers..."
cd "$PROJECT_DIR"
docker compose down 2>/dev/null || docker-compose down 2>/dev/null || true

# 5. Start containers
echo "🚀 Starting containers..."
docker compose up -d 2>/dev/null || docker-compose up -d

echo ""
echo "=========================================="
echo "✅ Setup complete!"
echo ""
echo "📊 Container status:"
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
echo ""
echo "⏳ Wait 1-2 minutes for services to start, then:"
echo "  BrowserAI:  http://$(hostname -I | awk '{print $1}'):8787/"
echo "  Bridge:     http://$(hostname -I | awk '{print $1}'):8000/dashboard"
echo ""
echo "📋 View logs:"
echo "  docker logs -f browserai"
echo "  docker logs -f lmarena-bridge"
echo ""
echo "🔐 Add Arena token in bridge dashboard:"
echo "  Open http://$(hostname -I | awk '{print $1}'):8000/dashboard"
echo "  Default password: admin"
echo "=========================================="
