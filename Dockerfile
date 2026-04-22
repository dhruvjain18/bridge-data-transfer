# Lightweight Node.js — no Chromium/Puppeteer needed with Baileys
FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE ${PORT:-3000}

CMD ["npm", "start"]
