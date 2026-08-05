# Immich Album Sync
<img width="783" height="733" alt="image" src="https://github.com/user-attachments/assets/9dd2d1b7-b315-4454-a822-2acae56d5081" />

🇩🇪 [Deutsche Version](README.de.md)

Import a **shared Immich album link** from a friend's separate Immich server
into your own Immich library — rebuilding the album along the way.

Works without needing the other person's API key: all it needs is the public
share link (optionally with a password). Handy if you and a friend each run
your own self-hosted Immich instance and want to pull a shared album into
your own library instead of just viewing it.

**Why this exists:** Immich's built-in album sharing only works between users
on the *same* server. If a friend runs their own separate Immich instance,
there's no native way to bring a shared album into your own library — this
tool bridges that gap using only the public share link.

## Features

- 🔗 Paste a share link, done — no API key needed from the person sharing it
- 🔍 **Auto-detects the source**: an Immich share link and a Google Photos
  share link are handled automatically, no need to tell it which is which
- 🖼️ **Import as album** — recreates the album with its original title on
  your instance and files new photos into it, or **📷 photos only** — imports
  everything straight into your library, no album
- 🔁 Re-run-safe: Immich's own checksum-based dedup means running it again
  only pulls in genuinely new photos; the target album is reused, not
  duplicated
- 🔐 Immich API key is entered through the UI (masked input), verified
  against your instance, and stored AES-256-GCM-encrypted on disk — never in
  plain text, never sent back to the browser
- 🔒 Login-protected (HTTP Basic Auth), rate-limited, CSRF- and
  SSRF-hardened out of the box — see [Security](#security)
- 🌐 UI available in German and English (toggle in the top bar)
- 🐳 Ships with a `Dockerfile` and `docker-compose.yml`

## Importing from Google Photos

Google locked down third-party programmatic access to shared albums in 2025
(and even the community scraping tools that filled the gap were reportedly
broken again by further changes in 2026), so "just paste a link" isn't a
fully reliable option for Google Photos the way it is for Immich. This tool
offers both of the realistic paths, under the **📦 Google Photos ZIP** tab
next to the link field:

- **ZIP upload (recommended, robust):** open the shared album in your
  browser, click Google's own **"Download all"** button, and drop the
  resulting ZIP file into this tool. It extracts the photos/videos, reads
  EXIF dates where available (falling back to the file dates preserved in
  the ZIP), and imports them exactly like an Immich share — as a named
  album or as loose photos. This doesn't depend on Google's API or page
  structure at all, so it isn't going to suddenly break.
- **Automatic scraping (experimental):** if you paste a Google Photos share
  link into the regular link field, the tool auto-detects it and attempts a
  best-effort scrape of the public share page for embeddable photo URLs.
  This can simply stop working at any time without warning if Google
  changes their page — when it fails, the tool tells you so and points you
  at the ZIP option above.

## Requirements

- Node.js ≥ 20 (ships with native `fetch`, `FormData`, `Blob`) — or Docker
- Your own Immich API key (Immich → Account Settings → API Keys → "New API
  Key")
- The friend sharing the album needs **"Allow download"** enabled on the
  share link, otherwise the original files can't be fetched.

## Setup

```bash
npm install
cp .env.example .env
```

Open `.env` and fill in:

```
OWN_IMMICH_URL=https://immich.myserver.com
APP_USERNAME=me
APP_PASSWORD=please-set-a-long-random-password
SETTINGS_ENCRYPTION_KEY=   # generate with: openssl rand -hex 32
PORT=3050
```

You do **not** put your Immich API key in `.env` — you enter it in the web
UI after the first start (see below), where it's stored encrypted.

Start it:

```bash
npm start
```

Then open `http://localhost:3050` in your browser (or your server's
IP/hostname, e.g. if it's running on a NAS). The top bar has an EN/DE toggle
next to the settings gear — your browser remembers the choice.

## Adding your Immich API key

Click the ⚙ gear icon top-right, paste your API key (the field is masked,
like a password field — nothing shows on screen while typing) and click
"Save & verify". The key is tested live against your Immich instance (you'll
see "connected as ...") and only then stored **encrypted** (AES-256-GCM) in
`data/settings.json` — the plaintext only ever lives briefly in the server's
memory, never on disk, never sent back to the browser again. To change it,
just enter a new key and save again.

## Usage

1. Paste the full share link from your friend (`https://.../share/...`).
2. If the album is password-protected, enter the password too.
3. Choose the import mode:
   - **🖼️ Import as album** (default): creates an album on your instance
     with the shared album's title (or updates it) and files all photos into
     it.
   - **📷 Photos only**: imports every photo straight into your library, no
     album created.
4. Click "Start import". Progress streams live.

Running it again on the same link only transfers **new** photos — Immich's
own checksum matching detects and skips anything already imported. The
target album is reused instead of being recreated (the mapping lives locally
in `data/album-mappings.json`).

## Deploying as a Docker container / TrueNAS Custom App

The project ships with a `Dockerfile` and `docker-compose.yml`.

### 1. Create a folder on your server

E.g. `/mnt/<pool>/apps/immich-album-sync/`, place the whole project there,
and create a `data/` subfolder for the persistent album mapping (if not
already present).

The container deliberately does **not** run as root — it runs as the `node`
image's built-in user, UID/GID `1000`. For it to be able to write into the
mounted `data` folder, set the ownership accordingly:

```bash
chown -R 1000:1000 /mnt/<pool>/apps/immich-album-sync/data
```

(Otherwise you'll get a "permission denied" when it tries to write the
album mapping during a sync.)

### 2. Build the image

On your server's shell, from the project folder:

```bash
docker build -t immich-album-sync:latest .
```

### 3a. Run via docker compose (simplest)

Open `docker-compose.yml` first and replace the placeholders under
`environment:` with your real values (`OWN_IMMICH_URL`, `APP_USERNAME`,
`APP_PASSWORD`, `SETTINGS_ENCRYPTION_KEY` — generate the latter with
`openssl rand -hex 32`). You'll enter your Immich API key later in the web
UI under Settings, not here. Then:

```bash
docker compose up -d
```

The tool is then reachable at `http://<server-ip>:3050`.

### 3b. As a TrueNAS SCALE "Custom App"

1. Apps → Discover Apps → **Custom App** (or "Install via YAML", depending
   on your SCALE version).
2. If it asks for an image field: enter `immich-album-sync` as the
   repository and `latest` as the tag, and set **Pull Policy to
   "Never"/"IfNotPresent"** (the image is already local from step 2 — it
   won't be pulled from a registry).
3. If the app accepts a raw `docker-compose.yml` via a YAML editor: paste
   the file's contents (with real values instead of the placeholders) and
   replace the `./data` volume path with your actual TrueNAS dataset path,
   e.g.:
   ```yaml
   volumes:
     - /mnt/<pool>/apps/immich-album-sync/data:/app/data
   ```
4. Expose port `3050` (or a host port of your choice).
5. Deploy — the UI is then reachable at `http://<server-ip>:<port>`,
   protected by the login from `APP_USERNAME`/`APP_PASSWORD`.

**Note:** only put real credentials into your local `docker-compose.yml` or
directly into the TrueNAS form — don't commit them to a Git repo.

### Updating after code changes

```bash
docker compose build
docker compose up -d
```

## Security

The tool is hardened against unauthorized access out of the box:

- **HTTP Basic Auth** in front of the entire app (credentials
  `APP_USERNAME`/`APP_PASSWORD` in `.env`). Without them, nobody can open
  the UI or call the API.
- **Rate limiting** (30 attempts / 10 min per IP) against password
  guessing.
- **CSRF protection**: requests that are clearly triggered from a foreign
  page (`Sec-Fetch-Site: cross-site`) are rejected — relevant because
  browsers otherwise attach cached Basic Auth credentials automatically per
  origin, regardless of which page actually triggered the request.
- **SSRF protection**: share links pointing at `localhost`, `127.0.0.1`,
  `192.168.x.x`, `10.x.x.x`, `172.16-31.x.x`, or link-local addresses are
  rejected, so the tool can't be abused to probe internal addresses. This
  only checks the hostname given in the link itself (it doesn't fully
  prevent DNS rebinding to an internal IP) — the actual backstop is that the
  route is only reachable with a valid login in the first place.
- Your Immich API key **never lives in `.env`** — it's entered through the
  Settings panel in the UI (masked field, like a password field) and stored
  AES-256-GCM-encrypted in `data/settings.json`. The key used to encrypt it
  (`SETTINGS_ENCRYPTION_KEY`) lives separately in `.env` — without it, the
  file can't be decrypted. The key itself is never sent back to the
  browser, not even after saving.

**Additionally recommended if this needs to be reachable beyond your LAN:**

- Only run it behind a reverse proxy with **HTTPS** (Basic Auth otherwise
  sends credentials unencrypted).
- Lock down `.env` with `chmod 600 .env` from other users on the server.
- Ideally don't expose it publicly at all — keep it reachable only via
  VPN/LAN.

## Limitations

- Face/people recognition, album comments, etc. are not transferred — only
  the original files (with EXIF data intact) and the album itself.
- Large videos can take a while, since they're fully buffered in memory
  before being uploaded.
- If the friend deletes the share link or it expires, re-syncing will stop
  working.
- With the automatic Google Photos scraper, original filenames and capture
  dates are lost (Google doesn't expose that metadata there) — the ZIP
  import path preserves both in most cases.

## Contributing

Issues and pull requests are welcome. This started as a small personal tool,
so expect some rough edges — bug reports with your Immich server version are
especially helpful.

## License

MIT

---

The Immich logo (`public/immich-logo.svg`) is the property of the
[Immich](https://github.com/immich-app/immich) project, used here only to
identify compatibility. This is an unofficial, community-built tool and is
not affiliated with or endorsed by the Immich project.
