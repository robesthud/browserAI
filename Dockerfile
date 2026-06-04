FROM node:20
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build
ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server/index.js"]
