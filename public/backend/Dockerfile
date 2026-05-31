# ============================================
# AI CODE STUDIO - BACKEND DOCKERFILE
# Multi-stage production build with native build tools (node-pty)
# ============================================

# --- Build Stage ---
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Install native compilation dependencies for node-pty
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy configuration and dependency manifest
COPY package*.json ./
RUN npm ci

# Copy Prisma schema and compile client binary
COPY prisma ./prisma/
RUN npx prisma generate

# Copy source and build TypeScript to Javascript
COPY . .
RUN npm run build

# --- Production Stage ---
FROM node:20-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

# Install runtime dependencies for native node-pty execution
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy production node_modules from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist ./dist

# Create storage volume directory
RUN mkdir -p /app/data/projects

EXPOSE 3000

CMD ["node", "dist/index.js"]
