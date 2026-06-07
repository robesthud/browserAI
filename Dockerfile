# syntax=docker/dockerfile:1.6
# ─────────────── Builder ───────────────
FROM node:22-alpine AS builder
WORKDIR /app

# Install all deps (incl. devDependencies for vite build)
COPY package.json package-lock.json* ./
RUN npm ci

# Copy sources and build the Vite frontend into /app/dist
COPY . .
RUN npm run build

# Prune devDependencies for the runtime image
RUN npm prune --omit=dev

# ─────────────── Runtime ───────────────
FROM node:22-alpine AS runtime
WORKDIR /app

# Native deps for better-sqlite3 + docker-cli so the agent loop can
# 'docker exec agent-sandbox …' through the mounted /var/run/docker.sock
RUN apk add --no-cache python3 make g++ docker-cli openssh-client \
 && rm -rf /var/cache/apk/*

# Copy app + built assets + production node_modules
COPY --from=builder /app/package.json /app/package-lock.json* ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server ./server
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

# Persisted state (sessions, workspace, deepseek_session.json, sqlite db)
RUN mkdir -p /data /workspace
ENV NODE_ENV=production
ENV PORT=8080
ENV WORKSPACE_ROOT=/workspace
EXPOSE 8080

CMD ["node", "server/index.js"]
