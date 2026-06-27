# syntax=docker/dockerfile:1.6
# ─────────────── Этап 1: Сборка Vite UI ───────────────
FROM node:22-alpine AS builder
WORKDIR /app/ui
COPY ui/package.json ui/package-lock.json* ./
RUN npm ci --include=dev
COPY ui/ .
RUN npm run build

# ─────────────── Этап 2: Python Monolith Runtime ───────────────
FROM python:3.12-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    sqlite3 curl git bash \
 && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir fastapi uvicorn httpx websockets pydantic aiosqlite

COPY --from=builder /app/ui/dist ./ui/dist
COPY core ./core

RUN mkdir -p /data /workspace
ENV BROWSERAI_DB=/data/browserai.db
ENV PORT=8080
EXPOSE 8080

CMD ["uvicorn", "core.server:app", "--host", "0.0.0.0", "--port", "8080"]
