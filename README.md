# Immich Album Sync

🇬🇧 [English version](README.md)

Importiert ein per **Share-Link** geteiltes Immich-Album (von einem fremden
Immich-Server, z.B. dem deines Kumpels) in deine eigene Immich-Bibliothek –
inklusive Nachbau des Albums.

Funktioniert ohne API-Key des anderen: es wird nur der öffentliche Share-Link
(optional mit Passwort) benötigt.

## Features

- 🔗 Link einfügen, fertig – erkennt automatisch, ob es ein Immich- oder
  Google-Fotos-Link ist
- 🖼️ **Album übernehmen** (mit Originaltitel, Fotos wandern rein) oder
  **📷 nur Fotos** (direkt in die Bibliothek, ohne Album)
- 🎯 **Zielalbum-Auswahl**: schlägt automatisch ein bestehendes Album mit
  ähnlichem Namen vor (z.B. "Spanien Urlaub 2026" ↔ "Spanien Urlaub") und
  ergänzt dort statt ein Duplikat anzulegen – oder manuell ein beliebiges
  bestehendes Album wählen, oder immer neu anlegen
- 👀 **Vorschau vor dem Import**: Thumbnails, Anzahl Fotos und vorgeschlagenes
  Zielalbum ansehen, bevor irgendetwas heruntergeladen/hochgeladen wird –
  bei Immich-Links, Google-Fotos-Links und ZIP-Uploads gleichermaßen
- 📊 Echter Fortschrittsbalken während des Imports, nicht nur ein Log
- 🕘 **Verlauf**-Reiter mit alle vergangenen Importen + Ein-Klick
  "erneut synchronisieren" (bei Immich-/Google-Quellen)
- 🔁 **Abos**: aus jedem Immich- oder Google-Fotos-Link ein dauerhaftes Abo
  machen, das sich selbst in einem gewählten Intervall (15 Min / stündlich /
  alle 6h / täglich) prüft und neue Fotos automatisch nachzieht
- 🔔 Optionale **Home-Assistant-Webhook**-Benachrichtigung nach jedem
  abgeschlossenen Import (manuell oder per Abo)
- 📱 Als Homescreen-App installierbar (PWA)
- 🔁 Re-Sync-sicher: Immichs eigene Checksum-Erkennung sorgt dafür, dass ein
  erneuter Lauf nur wirklich neue Fotos überträgt
- 🔐 Immich API-Key wird über die Oberfläche eingetragen (maskiertes Feld),
  gegen deine Instanz geprüft und AES-256-GCM-verschlüsselt gespeichert –
  nie im Klartext, nie an den Browser zurückgeschickt
- 🔒 Login-geschützt (HTTP Basic Auth), Rate-Limiting, CSRF- und
  SSRF-gehärtet – siehe [Sicherheit](#sicherheit)
- 🌐 Oberfläche auf Deutsch und Englisch (Umschalter oben)
- 🐳 Fertiger `Dockerfile` + `docker-compose.yml`

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

**Docker (empfohlen, ein einziger Befehl):**

```bash
git clone https://github.com/<du>/immich-album-sync.git
cd immich-album-sync
./install.sh
```

Das war's. Kein `.env`-Editieren, kein `openssl rand`. Das Skript baut das
Image, startet den Container und gibt am Ende einen automatisch generierten
Login (Benutzername + starkes Zufallspasswort) aus – das ist das einzige,
was du dir notieren musst. Deine Immich-URL und deinen API-Key trägst du
danach bequem im Browser ein.

**Ohne Docker (reines Node.js ≥ 20):**

```bash
npm install
npm start
```

Auch hier: null Konfiguration nötig zum Starten. `http://localhost:3050`
öffnen, die Konsole zeigt beim ersten Start den generierten Login:

```
========================================================
 First run: generated a login for the web UI.
 Username: admin
 Password: <zufällig>
 Saved to data/credentials.json - keep that folder backed up,
 this is shown here only once.
========================================================
```

<details>
<summary>Lieber feste statt automatisch generierter Werte? (optional)</summary>

`.env.example` zu `.env` kopieren und `APP_USERNAME`, `APP_PASSWORD` und/oder
`SETTINGS_ENCRYPTION_KEY` (`openssl rand -hex 32`) eintragen – was du dort
setzt, wird verwendet statt automatisch generiert zu werden. Praktisch für
automatisierte/wiederholbare Deployments, bei denen du die Zugangsdaten
vorher kennen willst.

</details>

Oben rechts kannst du die Oberfläche jederzeit zwischen Deutsch und Englisch
umschalten (Knopf "EN"/"DE" neben dem Zahnrad) – die Einstellung merkt sich
der Browser.

## Immich-Verbindung einrichten

Mit den Zugangsdaten von oben einloggen, oben rechts auf das ⚙ Zahnrad-Symbol
klicken und ausfüllen:

- **Deine Immich-URL** (z.B. `https://immich.meinserver.de`)
- **Dein Immich API-Key** (Immich → Account-Einstellungen → API-Keys →
  "New API Key") – das Feld ist maskiert, wie ein Passwortfeld, niemand am
  Bildschirm kann mitlesen

Auf "Speichern & prüfen" klicken. Beides wird live gegen deine Immich-
Instanz getestet (du siehst "verbunden als ...") und erst danach
gespeichert – die URL im Klartext (nicht sensibel), der API-Key
**verschlüsselt** (AES-256-GCM) in `data/settings.json`. Der Klartext des
Keys existiert nur kurz im Arbeitsspeicher des Servers, nie auf der Platte
und nie wieder im Browser. Zum Ändern einfach neue Werte eintragen und
erneut speichern.

## Nutzung

1. Kompletten Share-Link vom Kumpel einfügen (`https://.../share/...`).
2. Falls das Album passwortgeschützt ist: Passwort mit eintragen.
3. Import-Art wählen:
   - **🖼️ Album übernehmen** (Standard): legt bei dir ein Album mit dem Titel
     des geteilten Albums an (oder aktualisiert es) und ordnet alle Fotos dort ein.
   - **📷 Nur Fotos**: importiert alle Fotos direkt in deine Bibliothek, ohne
     ein Album anzulegen.
4. Bei "Album übernehmen" zusätzlich ein **Zielalbum** wählen:
   - **🔎 Automatisch** (Standard): schlägt automatisch ein bestehendes Album
     mit ähnlichem Namen vor (z.B. wird ein geteiltes "Spanien Urlaub 2026"
     erkannt und in dein vorhandenes "Spanien Urlaub" eingeordnet statt ein
     Duplikat anzulegen) – findet sich nichts Passendes, wird neu angelegt.
   - Ein **bestimmtes bestehendes Album** aus der Liste auswählen, um dort
     unabhängig vom Namen einzusortieren.
   - **🆕 Immer neues Album anlegen**, um die automatische Erkennung zu
     überstimmen.
5. Klick auf "Import starten". Fortschritt wird live angezeigt.

Beim erneuten Ausführen mit demselben Link werden nur **neue** Fotos
übertragen – bereits importierte Assets erkennt Immich selbst anhand der
Prüfsumme und überspringt sie. Das Zielalbum wird dabei wiederverwendet statt
erneut angelegt (Zuordnung liegt lokal in `data/album-mappings.json`).

## Abos (automatischer Wiederhol-Sync)

Im Reiter **🔁 Abos** einen beliebigen Immich- oder Google-Fotos-Link
einfügen, Modus/Zielalbum wählen und ein Intervall festlegen. Das Tool prüft
im Hintergrund einmal pro Minute, ob ein Abo fällig ist, und führt es dann
still aus – kein Browser-Tab muss offen bleiben, es läuft, solange der
Container/Prozess läuft. Jedes Abo merkt sich direkt in der Liste den
letzten Lauf-Zeitpunkt und das Ergebnis (oder den Fehler) und lässt sich
jederzeit pausieren oder löschen.

## Home-Assistant-Benachrichtigungen

`HOME_ASSISTANT_WEBHOOK_URL` in der `.env` auf eine Home-Assistant-Webhook-
URL setzen (Einstellungen → Automatisierungen → neue Automatisierung mit
Trigger **Webhook** anlegen, URL kopieren) und das Tool schickt nach jedem
abgeschlossenen Import (manuell oder per Abo) einen kleinen JSON-Payload
(`{ event: "immich_album_sync_completed", albumName, created, duplicates,
failed, ... }`) dorthin. Leer lassen, um das komplett zu deaktivieren.

## Deployment als Docker Container / TrueNAS Custom App

Im Projekt liegen dafür bereits `Dockerfile`, `docker-compose.yml` und `install.sh`.

### 1. Ordner auf die TrueNAS legen

Z. B. unter `/mnt/<pool>/apps/immich-album-sync/` den kompletten Projektordner
ablegen und dort einen Unterordner `data/` anlegen (falls nicht schon
vorhanden) – dort landen der automatisch generierte Login, der
Verschlüsselungs-Key, deine Einstellungen und der Sync-Verlauf.

Der Container läuft absichtlich **nicht als root**, sondern als der im
`node`-Image eingebaute User mit UID/GID `1000`. Damit er in den gemounteten
`data`-Ordner schreiben darf, dessen Besitzer passend setzen:

```bash
chown -R 1000:1000 /mnt/<pool>/apps/immich-album-sync/data
```

(Sonst gibt's beim allerersten Start einen "permission denied", weil die
generierten Zugangsdaten nicht gespeichert werden können.)

### 2a. Ein Befehl (am einfachsten)

Auf der TrueNAS-Shell (TrueNAS SCALE hat eine eingebaute Web-Shell direkt in
der Oberfläche – kein separater SSH-Client nötig, oben rechts auf das
Terminal-Symbol klicken), im Projektordner:

```bash
./install.sh
```

Baut das Image, startet den Container per `docker compose` und gibt am Ende
deinen automatisch generierten Login aus. Das Tool ist danach unter
`http://<truenas-ip>:3050` erreichbar – ganz ohne `docker-compose.yml` zu
bearbeiten.

### 2b. Manuell per docker compose

```bash
docker build -t immich-album-sync:latest .
docker compose up -d
docker compose logs   # zeigt beim ersten Start den generierten Login
```

`docker-compose.yml` musst du nur anfassen, wenn du bewusst feste statt
automatisch generierter Zugangsdaten willst (siehe den auskommentierten
`environment:`-Block in der Datei).

### 2c. Als TrueNAS SCALE "Custom App"

1. Das Image einmal per Shell bauen (Schritt 2a oder 2b oben).
2. Apps → Discover Apps → **Custom App** (bzw. "Install via YAML", je nach
   SCALE-Version).
3. Falls es ein Image-Feld verlangt: `immich-album-sync` als Repository und
   `latest` als Tag eintragen, **Pull Policy auf "Never"/"IfNotPresent"**
   stellen (das Image liegt ja schon lokal – es wird nicht aus einer
   Registry gezogen).
4. Volume von deinem TrueNAS-Datensatz auf `/app/data` mappen, z. B.:
   ```yaml
   volumes:
     - /mnt/<pool>/apps/immich-album-sync/data:/app/data
   ```
5. Port `3050` (oder einen von dir gewählten Host-Port) freigeben,
   Umgebungsvariablen leer lassen, außer du willst feste Zugangsdaten.
6. Deployen – einmal in die Container-Logs schauen für den generierten
   Login, dann `http://<truenas-ip>:<port>` öffnen.

### Update / Neubau nach Codeänderungen

```bash
docker compose build
docker compose up -d
```

## Sicherheit

Das Tool ist jetzt gegen Fremdzugriff abgesichert:

- **HTTP Basic Auth** vor der kompletten App. Standardmäßig wird beim ersten
  Start ein starkes Zufalls-Login generiert und in `data/credentials.json`
  gespeichert (einmalig in der Konsole/den Logs angezeigt) – oder du setzt
  `APP_USERNAME`/`APP_PASSWORD` selbst in der `.env`, falls du feste Werte
  willst. Ohne gültige Zugangsdaten kann niemand die Oberfläche öffnen oder
  die API ansprechen.
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
