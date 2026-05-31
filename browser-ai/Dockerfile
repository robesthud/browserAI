FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install

COPY browser_agent.ts ./

EXPOSE 8080

CMD ["npm", "start"]
