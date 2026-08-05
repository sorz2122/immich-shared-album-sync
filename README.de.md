# Immich Album Sync

🇬🇧 [English version](README.md)

Importiert ein per **Share-Link** geteiltes Immich-Album (von einem fremden
Immich-Server, z.B. dem deines Kumpels) in deine eigene Immich-Bibliothek –
inklusive Nachbau des Albums.

Funktioniert ohne API-Key des anderen: es wird nur der öffentliche Share-Link
(optional mit Passwort) benötigt.

## Google Fotos importieren

Google hat 2025 den programmatischen Drittanbieter-Zugriff auf geteilte
Alben stark eingeschränkt (und laut Berichten sind selbst die
Community-Ausweichlösungen, die diese Lücke gefüllt haben, durch weitere
Änderungen 2026 erneut kaputtgegangen). "Einfach Link einfügen" ist bei
Google Fotos also aktuell kein zuverlässiger Weg, anders als bei Immich.
Das Tool bietet dir beide realistischen Wege an, unter dem Reiter
**📦 Google-Fotos-ZIP** neben dem Link-Feld:

- **ZIP-Upload (empfohlen, robust):** Geteiltes Album im Browser öffnen, auf
  Googles eigenen **"Alle herunterladen"**-Button klicken und die
  entstandene ZIP-Datei hier reinziehen. Das Tool entpackt Fotos/Videos,
  liest EXIF-Daten wo vorhanden aus (sonst Fallback auf die in der ZIP
  gespeicherten Dateidaten) und importiert sie genau wie bei Immich – als
  benanntes Album oder lose Fotos. Hängt an keiner Stelle von Googles API
  oder Seitenstruktur ab, kann also nicht plötzlich kaputtgehen.
- **Automatisches Scraping (experimentell):** Fügst du einen Google-Fotos-
  Link ins normale Link-Feld ein, erkennt das Tool das automatisch und
  versucht, die öffentliche Album-Seite nach einbettbaren Foto-URLs zu
  durchsuchen. Das kann jederzeit ohne Vorwarnung aufhören zu funktionieren,
  wenn Google die Seite ändert – bei einem Fehlschlag weist dich das Tool
  direkt auf die ZIP-Option oben hin.

## Voraussetzungen

- Node.js ≥ 20 (bringt `fetch`, `FormData`, `Blob` nativ mit)
- Dein eigener Immich API-Key (Immich → Account-Einstellungen → API-Keys → "New API Key")
- Der Freund muss beim Erstellen des Share-Links **"Download erlauben"**
  aktiviert haben, sonst können die Originaldateien nicht geladen werden.

## Einrichtung

```bash
npm install
cp .env.example .env
```

`.env` öffnen und ausfüllen:

```
OWN_IMMICH_URL=https://immich.meinserver.de
APP_USERNAME=theo
APP_PASSWORD=bitte-ein-langes-zufaelliges-passwort-setzen
SETTINGS_ENCRYPTION_KEY=   # mit `openssl rand -hex 32` erzeugen
PORT=3050
```

Deinen Immich API-Key trägst du **nicht** in die `.env` ein, sondern nach dem
ersten Start bequem in der Weboberfläche (siehe unten) – dort wird er
verschlüsselt gespeichert.

Starten:

```bash
npm start
```

Dann im Browser `http://localhost:3050` öffnen (bzw. die IP/den Hostname
deines Servers, falls du es z.B. auf der TrueNAS laufen lässt). Oben rechts
kannst du die Oberfläche jederzeit zwischen Deutsch und Englisch umschalten
(Knopf "EN"/"DE" neben dem Zahnrad) – die Einstellung merkt sich der Browser.

## Immich API-Key hinterlegen

Oben rechts auf das ⚙ Zahnrad-Symbol klicken, API-Key einfügen (Feld ist
maskiert, wie ein Passwortfeld – niemand am Bildschirm kann ihn mitlesen) und
auf "Speichern & prüfen" klicken. Der Key wird dabei live gegen deine
Immich-Instanz getestet (du siehst "verbunden als ...") und erst danach
**verschlüsselt** (AES-256-GCM) in `data/settings.json` abgelegt – der
Klartext existiert nur kurz im Arbeitsspeicher des Servers, nie auf der
Platte und nie wieder im Browser. Zum Ändern einfach einen neuen Key
eintragen und erneut speichern.

## Nutzung

1. Kompletten Share-Link vom Kumpel einfügen (`https://.../share/...`).
2. Falls das Album passwortgeschützt ist: Passwort mit eintragen.
3. Import-Art wählen:
   - **🖼️ Album übernehmen** (Standard): legt bei dir ein Album mit dem Titel
     des geteilten Albums an (oder aktualisiert es) und ordnet alle Fotos dort ein.
   - **📷 Nur Fotos**: importiert alle Fotos direkt in deine Bibliothek, ohne
     ein Album anzulegen.
4. "Import starten" klicken. Fortschritt wird live angezeigt.

Beim erneuten Ausführen mit demselben Link werden nur **neue** Fotos
übertragen – bereits importierte Assets erkennt Immich selbst anhand der
Prüfsumme und überspringt sie. Das Zielalbum wird dabei wiederverwendet statt
erneut angelegt (Zuordnung liegt lokal in `data/album-mappings.json`).

## Deployment als Docker Container / TrueNAS Custom App

Im Projekt liegen dafür bereits `Dockerfile` und `docker-compose.yml`.

### 1. Ordner auf die TrueNAS legen

Z. B. unter `/mnt/<pool>/apps/immich-album-sync/` den kompletten Projektordner
ablegen und dort einen Unterordner `data/` für die persistente Album-Zuordnung
anlegen (falls nicht schon vorhanden).

Der Container läuft absichtlich **nicht als root**, sondern als der im
`node`-Image eingebaute User mit UID/GID `1000`. Damit er in den gemounteten
`data`-Ordner schreiben darf, dessen Besitzer passend setzen:

```bash
chown -R 1000:1000 /mnt/<pool>/apps/immich-album-sync/data
```

(Sonst gibt's beim Sync einen "permission denied" beim Schreiben der
Album-Zuordnung.)

### 2. Image bauen

Auf der TrueNAS-Shell (SSH) im Projektordner:

```bash
docker build -t immich-album-sync:latest .
```

### 3a. Starten via docker compose (am einfachsten)

`docker-compose.yml` vorher öffnen und die Platzhalter unter `environment:`
durch deine echten Werte ersetzen (`OWN_IMMICH_URL`, `APP_USERNAME`,
`APP_PASSWORD`, `SETTINGS_ENCRYPTION_KEY` – Letzteren mit
`openssl rand -hex 32` erzeugen). Den Immich API-Key trägst du danach in der
Weboberfläche unter "Einstellungen" ein, nicht hier. Danach:

```bash
docker compose up -d
```

Das Tool ist dann unter `http://<truenas-ip>:3050` erreichbar.

### 3b. Als TrueNAS SCALE "Custom App"

1. Apps → Discover Apps → **Custom App** (bzw. "Install via YAML", je nach
   SCALE-Version).
2. Falls es ein Image-Feld verlangt: `immich-album-sync` als Repository und
   `latest` als Tag eintragen, **Pull Policy auf "Never"/"IfNotPresent"**
   stellen (das Image liegt ja schon lokal aus Schritt 2 – es wird nicht aus
   einer Registry gezogen).
3. Falls die App den Inhalt von `docker-compose.yml` direkt per YAML-Editor
   annimmt: den Inhalt der Datei einfügen (mit ausgefüllten Umgebungsvariablen
   statt der Platzhalter) und den Volume-Pfad `./data` durch den echten
   TrueNAS-Datensatzpfad ersetzen, z. B.:
   ```yaml
   volumes:
     - /mnt/<pool>/apps/immich-album-sync/data:/app/data
   ```
4. Port `3050` (oder einen von dir gewählten Host-Port) freigeben.
5. Deployen – die Oberfläche ist danach unter `http://<truenas-ip>:<port>`
   erreichbar, geschützt durch den Login aus `APP_USERNAME`/`APP_PASSWORD`.

**Hinweis:** Trag echte Zugangsdaten nur in die lokale `docker-compose.yml`
bzw. direkt ins TrueNAS-Formular ein – nicht in ein Git-Repo committen.

### Update / Neubau nach Codeänderungen

```bash
docker compose build
docker compose up -d
```

## Sicherheit

Das Tool ist jetzt gegen Fremdzugriff abgesichert:

- **HTTP Basic Auth** vor der kompletten App (Zugangsdaten `APP_USERNAME`/`APP_PASSWORD`
  in `.env`). Ohne die kann niemand die Oberfläche öffnen oder die API ansprechen.
- **Rate-Limiting** (30 Versuche / 10 Min pro IP) gegen Durchprobieren des Passworts.
- **CSRF-Schutz**: Requests, die erkennbar von einer fremden Seite ausgelöst wurden
  (`Sec-Fetch-Site: cross-site`), werden abgelehnt – relevant, weil Browser
  Basic-Auth-Zugangsdaten sonst automatisch pro Origin mitschicken, auch wenn eine
  andere geöffnete Seite den Request auslöst.
- **SSRF-Schutz**: Share-Links, die auf `localhost`, `127.0.0.1`, `192.168.x.x`,
  `10.x.x.x`, `172.16-31.x.x` oder Link-Local-Adressen zeigen, werden abgelehnt,
  damit niemand das Tool missbrauchen kann, um interne Adressen abzufragen.
  Das prüft nur den im Link angegebenen Hostnamen selbst (DNS-Rebinding auf eine
  interne IP wird dadurch nicht zu 100% verhindert) – der eigentliche Schutz davor
  ist, dass die Route ohnehin nur mit gültigem Login erreichbar ist.
- Dein Immich API-Key liegt **nicht mehr in der `.env`**, sondern wird über
  die Einstellungen im Frontend eingetragen (maskiertes Feld, wie ein
  Passwortfeld) und AES-256-GCM-verschlüsselt in `data/settings.json`
  abgelegt. Der Schlüssel dazu (`SETTINGS_ENCRYPTION_KEY`) liegt separat in
  der `.env` – ohne den lässt sich die Datei nicht entschlüsseln. An den
  Browser wird der Key nie zurückgeschickt, auch nicht nach dem Speichern.

**Zusätzlich empfohlen, wenn das Tool über dein LAN hinaus erreichbar sein soll:**

- Nur über einen Reverse-Proxy mit **HTTPS** betreiben (Basic Auth schickt die
  Zugangsdaten sonst unverschlüsselt).
- `.env` mit `chmod 600 .env` vor anderen Nutzern auf dem Server schützen.
- Idealerweise gar nicht öffentlich exposen, sondern nur per VPN/LAN erreichbar
  machen.

## Grenzen

- Personen-/Gesichtserkennung, Alben-Kommentare u.ä. werden nicht mit
  übertragen – nur die Originaldateien inkl. EXIF-Daten und das Album selbst.
- Videos können je nach Größe etwas dauern, da sie komplett im Arbeitsspeicher
  gepuffert werden, bevor sie hochgeladen werden.
- Falls der Freund den Share-Link löscht oder das Ablaufdatum erreicht ist,
  funktioniert der erneute Sync nicht mehr.
- Beim automatischen Google-Fotos-Scraping gehen Originaldateiname und
  Aufnahmedatum verloren (Google liefert dort keine Metadaten mit) – beim
  ZIP-Import bleiben beide meist erhalten.

---

Das Immich-Logo (`public/immich-logo.svg`) gehört dem
[Immich](https://github.com/immich-app/immich)-Projekt und wird hier nur zur
Kompatibilitäts-Kennzeichnung verwendet. Dies ist ein inoffizielles,
community-gebautes Tool ohne Zugehörigkeit zum oder Unterstützung durch das
Immich-Projekt.
