# Immich Album Sync

🇬🇧 [English version](README.md)

Importiert geteilte Immich-Alben über einen öffentlichen Share-Link in die eigene Immich-Instanz. Dabei können die Dateien entweder in ein bestehendes oder neues Album übernommen oder direkt in die Bibliothek importiert werden.

Für die Quellinstanz wird kein API-Key benötigt. Ein Share-Link mit aktivierter Download-Berechtigung reicht aus.

## Features

* Import von öffentlichen Immich-Share-Links, optional mit Passwort
* Import als Album oder direkt in die Bibliothek
* Auswahl eines bestehenden Zielalbums oder automatische Zuordnung anhand des Albumnamens
* Vorschau mit Thumbnails und Asset-Anzahl vor dem Import
* Fortschrittsanzeige während des Imports
* Import-Verlauf mit erneutem Synchronisieren vorhandener Quellen
* Automatische Synchronisierung von Immich- und Google-Fotos-Quellen in konfigurierbaren Intervallen
* Optionaler Home-Assistant-Webhook nach abgeschlossenen Imports
* PWA-Unterstützung
* Duplikaterkennung über Immich-Checksums
* Verschlüsselte Speicherung des Immich API-Keys mit AES-256-GCM
* HTTP Basic Auth, Rate Limiting sowie CSRF- und SSRF-Schutz
* Deutsche und englische Oberfläche
* Docker- und Docker-Compose-Support
* Unterstützung für TrueNAS SCALE

## Google Photos

Google Photos unterstützt den zuverlässigen Import öffentlicher geteilter Alben über Drittanbieter nur eingeschränkt. Deshalb gibt es zwei Importwege:

**ZIP-Import**

Das Album in Google Photos über „Alle herunterladen“ herunterladen und die ZIP-Datei anschließend hochladen. Bilder und Videos werden entpackt und inklusive verfügbarer Metadaten importiert.

Das ist der empfohlene Weg, da er nicht von Googles interner Seitenstruktur abhängt.

**Share-Link**

Öffentliche Google-Fotos-Links können ebenfalls verarbeitet werden. Dabei wird versucht, die verfügbaren Medien direkt aus der öffentlichen Albumseite auszulesen.

Dieser Weg ist experimentell und kann nach Änderungen auf Seiten von Google nicht mehr funktionieren.

## Voraussetzungen

* Node.js 20 oder neuer, alternativ Docker
* API-Key der eigenen Immich-Instanz
* Bei Immich-Share-Links muss „Download erlauben“ aktiviert sein

## Installation

### Docker

```bash
git clone https://github.com/<user>/immich-album-sync.git
cd immich-album-sync
./install.sh
```

Beim ersten Start werden automatisch Zugangsdaten für die Weboberfläche erzeugt und in `data/credentials.json` gespeichert.

Die Immich-URL und der API-Key werden anschließend über die Weboberfläche konfiguriert.

### Node.js

```bash
npm install
npm start
```

Die Oberfläche ist anschließend unter:

```text
http://localhost:3050
```

erreichbar.

Optional können feste Werte für `APP_USERNAME`, `APP_PASSWORD` und `SETTINGS_ENCRYPTION_KEY` über eine `.env`-Datei gesetzt werden.

## Immich konfigurieren

Nach dem Login können unter den Einstellungen folgende Werte hinterlegt werden:

* URL der eigenen Immich-Instanz
* Immich API-Key

Die Verbindung wird vor dem Speichern geprüft.

Der API-Key wird AES-256-GCM-verschlüsselt in `data/settings.json` gespeichert und nach dem Speichern nicht wieder an den Browser übertragen.

## Nutzung

1. Immich- oder Google-Fotos-Link einfügen.
2. Falls nötig, Passwort angeben.
3. Importmodus auswählen.
4. Optional ein bestehendes Zielalbum auswählen.
5. Vorschau prüfen und Import starten.

Bei wiederholten Imports erkennt Immich bereits vorhandene Dateien anhand ihrer Checksums. Dadurch werden nur neue Assets übertragen.

Die Zuordnung zwischen Quell- und Zielalben wird lokal in `data/album-mappings.json` gespeichert.

## Automatische Synchronisierung

Immich- und Google-Fotos-Quellen können als Subscription gespeichert und regelmäßig synchronisiert werden.

Unterstützte Intervalle:

* 15 Minuten
* stündlich
* alle 6 Stunden
* täglich

Die Synchronisierung läuft serverseitig und benötigt keinen geöffneten Browser.

## Home Assistant

Über `HOME_ASSISTANT_WEBHOOK_URL` kann nach jedem abgeschlossenen Import ein Webhook an Home Assistant gesendet werden.

Beispiel:

```json
{
  "event": "immich_album_sync_completed",
  "albumName": "...",
  "created": 10,
  "duplicates": 2,
  "failed": 0
}
```

Ohne konfigurierte URL bleibt die Funktion deaktiviert.

## Docker / TrueNAS SCALE

Persistente Daten liegen unter:

```text
/app/data
```

Bei einem manuellen Volume-Mount sollte der Ordner für UID/GID `1000` beschreibbar sein:

```bash
chown -R 1000:1000 /mnt/<pool>/apps/immich-album-sync/data
```

Start über Docker Compose:

```bash
docker compose up -d
```

Nach Änderungen:

```bash
docker compose build
docker compose up -d
```

Für TrueNAS SCALE kann das Image als Custom App verwendet werden. Dabei muss `/app/data` auf ein persistentes Dataset gemountet und Port `3050` veröffentlicht werden.

## Sicherheit

* HTTP Basic Auth für Weboberfläche und API
* Automatisch generierte Zugangsdaten beim ersten Start
* Rate Limiting für Login-Versuche
* CSRF-Schutz
* SSRF-Filter für lokale und private Zieladressen
* AES-256-GCM-verschlüsselte Speicherung des Immich API-Keys

Bei Zugriff außerhalb des lokalen Netzwerks sollte die Anwendung ausschließlich hinter einem Reverse Proxy mit HTTPS betrieben werden.

## Einschränkungen

* Personen-/Gesichtserkennung, Kommentare und weitere Album-Metadaten werden nicht übertragen
* Große Videos werden aktuell vollständig im Speicher gepuffert
* Abgelaufene oder gelöschte Share-Links können nicht erneut synchronisiert werden
* Beim experimentellen Google-Fotos-Linkimport stehen Dateinamen und Aufnahmedaten unter Umständen nicht zur Verfügung

## Contributing

Issues und Pull Requests sind willkommen.

Bei Bugreports sind Angaben zur verwendeten Immich-Version hilfreich.

## License

MIT

---

Das Immich-Logo (`public/immich-logo.svg`) gehört zum [Immich](https://github.com/immich-app/immich)-Projekt und wird ausschließlich zur Kennzeichnung der Kompatibilität verwendet.

Dieses Projekt ist ein inoffizielles Community-Tool und steht in keiner Verbindung zum Immich-Projekt.
