#!/bin/bash
# ============================================
# BrowserAI + LMArenaBridge Diagnostic Script
# Запустите на сервере: bash diagnose.sh
# ============================================

echo "=========================================="
echo "🔍 BrowserAI + Bridge Diagnostic Report"
echo "=========================================="
echo ""

echo "--- 1. System Info ---"
uname -a
echo "RAM: $(free -h 2>/dev/null | grep Mem || echo 'N/A')"
echo "Disk: $(df -h / | tail -1)"
echo ""

echo "--- 2. Docker Status ---"
docker --version 2>/dev/null || echo "❌ Docker not installed!"
docker-compose --version 2>/dev/null || docker compose version 2>/dev/null || echo "❌ docker-compose not found!"
echo ""

echo "--- 3. Running Containers ---"
docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Image}}"
echo ""

echo "--- 4. Container Logs (last 50 lines each) ---"
echo "=== browserai ==="
docker logs browserai --tail 50 2>&1 || echo "❌ Container 'browserai' not found"
echo ""
echo "=== lmarena-bridge ==="
docker logs lmarena-bridge --tail 50 2>&1 || echo "❌ Container 'lmarena-bridge' not found"
echo ""

echo "--- 5. Port Listening ---"
ss -tlnp 2>/dev/null | grep -E '8787|8000' || netstat -tlnp 2>/dev/null | grep -E '8787|8000' || echo "No listeners on 8787/8000"
echo ""

echo "--- 6. Docker Compose File ---"
if [ -f /root/browserai/docker-compose.yml ]; then
    echo "File found: /root/browserai/docker-compose.yml"
    cat /root/browserai/docker-compose.yml
elif [ -f /home/user/browserai/docker-compose.yml ]; then
    echo "File found: /home/user/browserai/docker-compose.yml"
    cat /home/user/browserai/docker-compose.yml
else
    echo "❌ docker-compose.yml NOT FOUND"
    find / -name "docker-compose.yml" -maxdepth 4 2>/dev/null
fi
echo ""

echo "--- 7. Bridge Config ---"
if [ -f /root/browserai/bridge_config/config.json ]; then
    echo "✅ config.json exists"
    cat /root/browserai/bridge_config/config.json | head -20
elif [ -d /root/browserai/bridge_config ]; then
    echo "📁 bridge_config dir exists but:"
    ls -la /root/browserai/bridge_config/
else
    echo "❌ bridge_config directory NOT FOUND"
fi
echo ""

echo "--- 8. Data Directory ---"
ls -la /root/browserai/data/ 2>/dev/null || echo "❌ /root/browserai/data/ not found"
echo ""

echo "--- 9. Environment Variables ---"
echo "ARENA_AUTH_COOKIE set: $([ -n "$ARENA_AUTH_COOKIE" ] && echo 'YES' || echo 'NO')"
echo "ARENA_ANON_KEY set: $([ -n "$ARENA_ANON_KEY" ] && echo 'YES' || echo 'NO')"
echo ""

echo "--- 10. Curl Tests ---"
echo "Testing http://localhost:8787/api/health ..."
curl -s -o /dev/null -w "HTTP Status: %{http_code}\n" http://localhost:8787/api/health 2>/dev/null || echo "❌ Connection refused"
echo ""
echo "Testing http://localhost:8000/api/v1/health ..."
curl -s -o /dev/null -w "HTTP Status: %{http_code}\n" http://localhost:8000/api/v1/health 2>/dev/null || echo "❌ Connection refused"
echo ""

echo "--- 11. Firewall ---"
ufw status 2>/dev/null || iptables -L -n 2>/dev/null | head -20 || echo "No firewall info available"
echo ""

echo "=========================================="
echo "✅ Diagnostic complete. Copy output above."
echo "=========================================="
