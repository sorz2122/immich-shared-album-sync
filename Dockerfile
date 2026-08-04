# --- Build/Run in einem schlanken Node-Image ---
FROM node:20-alpine

WORKDIR /app

# Nur die Manifeste zuerst kopieren, damit Docker den npm-Layer cachen kann
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App-Code kopieren
COPY server.js ./
COPY public ./public

# Datenverzeichnis für die lokale Album-Zuordnung anlegen und dem
# eingebauten, unprivilegierten "node"-User gehören lassen
RUN mkdir -p /app/data && chown -R node:node /app

USER node

ENV PORT=3050
EXPOSE 3050

CMD ["node", "server.js"]
