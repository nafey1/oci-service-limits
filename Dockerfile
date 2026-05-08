FROM node:22-slim

ENV NODE_ENV=production
ENV HOST=0.0.0.0
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY README.md ./

USER node
EXPOSE 3000

CMD ["node", "src/server.js"]
