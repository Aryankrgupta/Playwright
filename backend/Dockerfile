FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN npx @playwright/mcp install-browser chrome --with-deps

CMD ["npm", "start"]