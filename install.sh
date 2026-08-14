#!/bin/bash
set -euo pipefail

echo "== Immich Album Sync - Setup =="

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker wurde nicht gefunden. Bitte Docker installieren und erneut versuchen."
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "Docker Compose wurde nicht gefunden."
  exit 1
fi

echo "-> Lade das aktuelle Container-Image ..."
$COMPOSE pull

echo "-> Starte Immich Album Sync ..."
$COMPOSE up -d

echo ""
echo "================================================================"
echo " Fertig!"
echo "================================================================"
echo "Öffne jetzt http://localhost:3050 oder http://DEINE-SERVER-IP:3050."
echo "Beim ersten Aufruf legst du Benutzername und Passwort selbst fest."
echo "Danach richtest du in der Weboberfläche deine Immich-URL und den API-Key ein."
