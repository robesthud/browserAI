# ============================================
# AI CODE STUDIO - BROWSER AGENT DOCKERFILE
# ============================================

# Use official Playwright Node.js image with pre-installed browser binaries
FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Expose microservice port
EXPOSE 8080

CMD ["npm", "start"]
