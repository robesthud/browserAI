#!/bin/sh

# ============================================
# AI CODE STUDIO - DATABASE INIT SCRIPT
# Waits for database and runs migrations
# ============================================

echo "⏳ Waiting for PostgreSQL to be ready..."
until pg_isready -h postgres -U aicode -d aicode; do
  sleep 1
done

echo "🚀 Database is up! Running prisma database push..."
npx prisma db push --accept-data-loss

echo "✅ Database initialized successfully!"
exec "$@"
