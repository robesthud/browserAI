#!/bin/sh

# ============================================
# AI CODE STUDIO - FRONTEND ENTRYPOINT SCRIPT
# Delays Nginx startup until Fastify Backend DNS resolve succeeds
# ============================================

echo "⏳ Waiting for backend service to be ready on network..."

# Wait for port 3000 on backend host
while ! nc -z backend 3000; do
  sleep 1
done

echo "✅ Backend detected! Starting Nginx webserver..."
exec nginx -g 'daemon off;'
