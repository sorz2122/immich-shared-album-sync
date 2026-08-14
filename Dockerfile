# --- Build/Run in einem schlanken Node-Image ---
FROM node:20-alpine

LABEL org.opencontainers.image.source="https://github.com/sorz2122/immich-shared-album-sync"
LABEL org.opencontainers.image.description="Import and sync shared Immich albums into your own Immich instance"

WORKDIR /app

# Nur die Manifeste zuerst kopieren, damit Docker den npm-Layer cachen kann
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App-Code kopieren
COPY server.js auth.js ./
COPY public ./public

# Persistentes Datenverzeichnis vorbereiten
RUN mkdir -p /app/data && chown -R node:node /app

USER node

ENV PORT=3050
EXPOSE 3050

CMD ["node", "server.js"]
