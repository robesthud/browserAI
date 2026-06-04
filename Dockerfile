FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm install
RUN npm run build
ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server/index.js"]
