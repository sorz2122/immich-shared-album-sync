#!/bin/bash
# One-command setup: builds the image, starts the container, and prints the
# auto-generated login once it's ready. Run this from inside the project
# folder (where this file, the Dockerfile and docker-compose.yml live).
set -e

echo "== Immich Album Sync - Setup =="

if ! command -v docker &> /dev/null; then
  echo "Docker wurde nicht gefunden. Bitte Docker installieren und erneut versuchen."
  echo "(Alternativ: npm install && npm start, siehe README.md)"
  exit 1
fi

mkdir -p data

echo "-> Baue das Docker-Image..."
docker build -t immich-album-sync:latest .

echo "-> Starte den Container..."
if docker compose version &> /dev/null; then
  docker compose up -d
  LOGS_CMD="docker compose logs"
else
  docker-compose up -d
  LOGS_CMD="docker-compose logs"
fi

echo "-> Warte auf den ersten Start..."
sleep 2

echo ""
echo "================================================================"
echo " Fertig! Login-Zugangsdaten (nur beim allerersten Start generiert):"
echo "================================================================"
$LOGS_CMD 2>/dev/null | grep -A 3 "generated a login" || echo "(Login stand schon in einem früheren Lauf in data/credentials.json)"
echo ""
echo "Öffne jetzt http://localhost:3050 (oder deine Server-IP:3050) im"
echo "Browser, logge dich ein und trage unter '⚙ Einstellungen' deine"
echo "Immich-URL + API-Key ein."
