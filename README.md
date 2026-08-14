# Immich Album Sync

🇩🇪 [Deutsche Version](README_DE.md)

Imports shared Immich albums into your own Immich instance using a public share link. Files can either be added to a new or existing album or imported directly into the library.

No API key is required for the source Immich instance. A share link with downloads enabled is enough.

## Features

* Import public Immich share links, including password-protected shares
* Import as an album or directly into the library
* Select an existing target album or automatically match one by name
* Preview thumbnails and asset count before importing
* Live import progress
* Import history with one-click re-sync
* Scheduled synchronization for Immich and Google Photos sources
* Optional Home Assistant webhook notifications
* PWA support
* Duplicate detection using Immich checksums
* AES-256-GCM encrypted storage of the Immich API key
* HTTP Basic Auth, rate limiting, CSRF protection and SSRF filtering
* English and German UI
* Docker and Docker Compose support
* TrueNAS SCALE support

## Google Photos

Reliable third-party access to public shared Google Photos albums is limited, so the application provides two import methods.

**ZIP import**

Download the shared album using Google Photos' “Download all” option and upload the resulting ZIP file.

Images and videos are extracted and imported together with any metadata that is available.

This is the recommended method because it does not depend on Google's internal page structure.

**Share link**

Public Google Photos links can also be processed directly. The application attempts to extract available media URLs from the public album page.

This method is experimental and may stop working when Google changes the page.

## Requirements

* Node.js 20 or newer, or Docker
* An API key for your own Immich instance
* Immich share links must have downloads enabled

## Installation

### Docker

```bash
git clone https://github.com/<user>/immich-album-sync.git
cd immich-album-sync
./install.sh
```

On first startup, credentials for the web interface are generated automatically and stored in `data/credentials.json`.

Your Immich URL and API key can then be configured through the web interface.

### Node.js

```bash
npm install
npm start
```

The application will be available at:

```text
http://localhost:3050
```

Fixed values for `APP_USERNAME`, `APP_PASSWORD` and `SETTINGS_ENCRYPTION_KEY` can optionally be configured through a `.env` file.

## Immich configuration

After logging in, configure:

* Your Immich instance URL
* Your Immich API key

The connection is verified before the settings are saved.

The API key is stored AES-256-GCM encrypted in `data/settings.json` and is not sent back to the browser after saving.

## Usage

1. Paste an Immich or Google Photos share link.
2. Enter a password if required.
3. Select the import mode.
4. Optionally select an existing target album.
5. Review the preview and start the import.

When importing the same source again, Immich's checksum detection skips assets that already exist.

Source-to-target album mappings are stored locally in `data/album-mappings.json`.

## Scheduled synchronization

Immich and Google Photos sources can be stored as subscriptions and synchronized automatically.

Available intervals:

* 15 minutes
* hourly
* every 6 hours
* daily

Synchronization runs on the server and does not require an open browser tab.

## Home Assistant

Set `HOME_ASSISTANT_WEBHOOK_URL` to send a webhook after every completed import.

Example payload:

```json
{
  "event": "immich_album_sync_completed",
  "albumName": "...",
  "created": 10,
  "duplicates": 2,
  "failed": 0
}
```

Leave the value unset to disable notifications.

## Docker / TrueNAS SCALE

Persistent application data is stored in:

```text
/app/data
```

For manual volume mounts, the directory needs to be writable by UID/GID `1000`:

```bash
chown -R 1000:1000 /mnt/<pool>/apps/immich-album-sync/data
```

Start with Docker Compose:

```bash
docker compose up -d
```

After code changes:

```bash
docker compose build
docker compose up -d
```

On TrueNAS SCALE, the image can be deployed as a Custom App. Mount a persistent dataset to `/app/data` and expose port `3050`.

## Security

* HTTP Basic Auth for the UI and API
* Automatically generated credentials on first startup
* Login rate limiting
* CSRF protection
* SSRF filtering for local and private network addresses
* AES-256-GCM encrypted storage of the Immich API key

If the application is accessible outside your local network, it should be placed behind a reverse proxy with HTTPS.

## Limitations

* Face recognition, comments and other album metadata are not transferred
* Large videos are currently buffered in memory before upload
* Expired or deleted share links cannot be synchronized again
* The experimental Google Photos link importer may not preserve filenames or capture dates

## Contributing

Issues and pull requests are welcome.

When reporting bugs, including your Immich version is helpful.

## License

MIT

---

The Immich logo (`public/immich-logo.svg`) belongs to the [Immich](https://github.com/immich-app/immich) project and is used only to indicate compatibility.

This is an unofficial community project and is not affiliated with or endorsed by the Immich project.
