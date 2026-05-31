# ============================================
# AI CODE STUDIO - BACKEND DOCKERFILE
# ============================================

FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy prisma schema and generate client
COPY prisma ./prisma/
RUN npx prisma generate

# Copy source
COPY . .

# Build TypeScript to Javascript
RUN npm run build

# Expose port
EXPOSE 3000

CMD ["npm", "start"]
