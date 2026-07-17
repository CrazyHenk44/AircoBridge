FROM node:24-alpine

LABEL org.opencontainers.image.source="https://github.com/CrazyHenk44/AircoBridge"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV AIRCO_CONFIG_FILE=/app/config/aircos.json

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY config/aircos.example.json ./config/aircos.example.json

EXPOSE 3000

CMD ["node", "src/server.js"]
