#!/bin/bash
# BrowserAI Health Alert — runs via cron every 10 min
set -euo pipefail

TOKEN_FILE="/opt/browserai/.env"
TG_BOT_TOKEN=""
TG_ADMIN_CHAT_ID=""
if [ -f "$TOKEN_FILE" ]; then
  TG_BOT_TOKEN=$(grep '^TG_BOT_TOKEN=' "$TOKEN_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'" | xargs)
  TG_ADMIN_CHAT_ID=$(grep '^TG_ADMIN_CHAT_ID=' "$TOKEN_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'" | xargs)
fi

if [ -z "$TG_BOT_TOKEN" ] || [ -z "$TG_ADMIN_CHAT_ID" ]; then
  exit 0
fi

HOST=$(hostname -s)
IP=$(hostname -I | awk '{print $1}')

# Disk check
DISK_PCT=$(df --output=pcent / | tail -1 | tr -dc '0-9' || echo 0)
if [ "$DISK_PCT" -ge 85 ]; then
  MSG="🚨 *BrowserAI Disk Alert* %0AHost: $HOST ($IP) %0ADisk usage: $DISK_PCT% ≥ 85% %0AAction: cleanup required"
  curl -s -X POST "https://api.telegram.org/bot$TG_BOT_TOKEN/sendMessage"     -d chat_id="$TG_ADMIN_CHAT_ID"     -d parse_mode="Markdown"     -d text="$MSG" > /dev/null || true
fi

# RAM check (available MB)
AVAIL_MB=$(free -m | awk '/^Mem:/ {print $7}')
if [ "$AVAIL_MB" -le 300 ]; then
  MSG="🚨 *BrowserAI RAM Alert* %0AHost: $HOST ($IP) %0AAvailable RAM: $AVAIL_MB MB ≤ 300 MB %0AAction: check processes / add swap"
  curl -s -X POST "https://api.telegram.org/bot$TG_BOT_TOKEN/sendMessage"     -d chat_id="$TG_ADMIN_CHAT_ID"     -d parse_mode="Markdown"     -d text="$MSG" > /dev/null || true
fi

# Swap check (if swap exists but fully used)
SWAP_USED=$(free -m | awk '/^Swap:/ {print $3}')
SWAP_TOTAL=$(free -m | awk '/^Swap:/ {print $2}')
if [ "$SWAP_TOTAL" -gt 0 ] && [ "$SWAP_USED" -ge "$SWAP_TOTAL" ]; then
  MSG="⚠️ *BrowserAI Swap Alert* %0AHost: $HOST ($IP) %0ASwap fully used: $SWAP_USED / $SWAP_TOTAL MB %0AAction: investigate memory leak"
  curl -s -X POST "https://api.telegram.org/bot$TG_BOT_TOKEN/sendMessage"     -d chat_id="$TG_ADMIN_CHAT_ID"     -d parse_mode="Markdown"     -d text="$MSG" > /dev/null || true
fi

# Docker health check
if ! docker ps --format '{{.Names}}' | grep -q '^browserai$'; then
  MSG="🔴 *BrowserAI Container Down* %0AHost: $HOST ($IP) %0Abrowserai container not running %0AAction: docker compose up -d"
  curl -s -X POST "https://api.telegram.org/bot$TG_BOT_TOKEN/sendMessage"     -d chat_id="$TG_ADMIN_CHAT_ID"     -d parse_mode="Markdown"     -d text="$MSG" > /dev/null || true
fi
