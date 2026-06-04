# BrowserAI — single-image full-stack (Express API + SQLite + собранный фронт)

FROM node:20-bookworm-slim AS build
WORKDIR /app
# системные зависимости для сборки better-sqlite3 (native)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
# каталог для файла БД и workspace (монтируется как volume)
ENV BROWSERAI_DB=/data/browserai.db
ENV WORKSPACE_ROOT=/data/workspace


# копируем только нужное для запуска сервера
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server ./server
COPY --from=build /app/dist ./dist

RUN mkdir -p /data
#VOLUME ["/data"]
EXPOSE 8787

CMD ["node", "server/index.js"]
