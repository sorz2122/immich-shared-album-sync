import 'dotenv/config';
import express from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import AdmZip from 'adm-zip';
import exifr from 'exifr';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuth } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPPINGS_FILE = path.join(__dirname, 'data', 'album-mappings.json');
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
const SUBSCRIPTIONS_FILE = path.join(__dirname, 'data', 'subscriptions.json');
const CREDENTIALS_FILE = path.join(__dirname, 'data', 'credentials.json');
const ENCRYPTION_ALGO = 'aes-256-gcm';

let OWN_IMMICH_URL = (process.env.OWN_IMMICH_URL || '').replace(/\/+$/, '');
let SETTINGS_ENCRYPTION_KEY_HEX = '';
const HOME_ASSISTANT_WEBHOOK_URL = process.env.HOME_ASSISTANT_WEBHOOK_URL || '';
const PORT = process.env.PORT || 3050;

// The Immich API key is never read from .env directly - it's set via the
// in-app Settings panel and kept encrypted on disk (see loadApiKey/saveApiKey
// below). Held in memory at runtime, never logged, never sent back to the browser.
let ownImmichApiKey = null;

const app = express();
app.set('trust proxy', 'loopback');

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anmeldeversuche. Bitte später erneut versuchen.' },
});

function requireSameOrigin(req, res, next) {
  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return res.status(403).send('Cross-site requests are not allowed.');
  }
  next();
}

app.use(express.json());

const auth = createAuth({
  credentialsFile: CREDENTIALS_FILE,
  publicDir: path.join(__dirname, 'public'),
  encryptionKeyFromEnv: process.env.SETTINGS_ENCRYPTION_KEY || '',
  usernameFromEnv: process.env.APP_USERNAME || '',
  passwordFromEnv: process.env.APP_PASSWORD || '',
  authLimiter,
  requireSameOrigin,
});

auth.registerRoutes(app);

// Statische Dateien wie Logo, CSS, Manifest und Service Worker bleiben öffentlich.
// index.html selbst wird durch die explizite Route in auth.js geschützt.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Alle nachfolgenden bestehenden API-Routen brauchen eine gültige Session.
app.use('/api', auth.requireAuth);

// ---------- i18n for log lines & error messages ----------

const STRINGS = {
  de: {
    connecting: (url) => `Verbinde mit ${url} ...`,
    loadingTimeline: 'Lade Bilderliste über die Zeit-Pakete (Timeline API) nach...',
    bucketsFound: (n) => `-> ${n} Zeit-Paket(e) im Album gefunden. Lade Inhalte...`,
    bucketParseError: (m) => `-> Fehler beim Parsen: ${m}`,
    timelineWarning: (m) => `-> Warnung: Fehler bei Timeline-Abfrage: ${m}`,
    albumFound: (name, n) => `Album gefunden: "${name}" mit ${n} Asset(s).`,
    noAssets: 'Keine Assets gefunden.',
    downloading: (id) => `Lade herunter: Asset ${id} ...`,
    actualFilename: (f) => `  -> echter Dateiname: ${f}`,
    uploaded: '  ✓ hochgeladen',
    duplicate: '  ↺ bereits vorhanden',
    assetError: (id, m) => `  ✗ Fehler bei ${id}: ${m}`,
    done: (c, d, f) => `Fertig: ${c} neu, ${d} bereits vorhanden, ${f} fehlgeschlagen.`,
    noApiKey: 'Kein Immich API-Key hinterlegt. Bitte zuerst in den Einstellungen eintragen.',
    noShareUrl: 'Bitte einen Share-Link angeben.',
    passwordRequired: 'Dieses Album ist passwortgeschützt. Bitte Passwort im Formular eintragen.',
    onlyHttp: 'Nur http(s)-Links sind erlaubt.',
    localBlocked: 'Lokale/interne Adressen sind als Share-Link nicht erlaubt.',
    noShareKey: 'Konnte keinen Share-Key aus der URL lesen.',
    wrongPassword: 'Falsches Passwort für den Share-Link.',
    loginFailed: (s) => `Login am Share-Link fehlgeschlagen (HTTP ${s}).`,
    shareInfoError: (s) => `Konnte Album-Infos nicht laden (HTTP ${s}).`,
    downloadError: (s) => `Download fehlgeschlagen (HTTP ${s}).`,
    uploadError: (s, tx) => `Upload fehlgeschlagen (HTTP ${s}): ${tx}`,
    albumCreateError: (s) => `Album anlegen fehlgeschlagen (HTTP ${s}).`,
    albumUpdateError: (s) => `Album aktualisieren fehlgeschlagen (HTTP ${s}).`,
    invalidKey: 'Bitte einen gültigen API-Key eingeben.',
    invalidUrl: 'Bitte eine gültige http(s)-URL für deine Immich-Instanz eingeben.',
    keyRejected: (s) => `Immich hat den Key abgelehnt (HTTP ${s}). Bitte prüfen.`,
    googleDetected: 'Google-Fotos-Link erkannt (experimentell).',
    googleScrapeFailed: (m) => `Automatischer Import fehlgeschlagen: ${m}`,
    googleScrapeSuggestZip:
      'Automatischer Google-Fotos-Import ist aktuell nicht zuverlässig möglich (Google hat den Zugriff eingeschränkt). ' +
      'Bitte stattdessen auf der geteilten Seite "Alle herunterladen" nutzen und die ZIP-Datei über den Reiter "Google-Fotos-ZIP" hochladen.',
    defaultGoogleAlbumName: 'Google-Fotos-Album',
    noZipFile: 'Bitte eine ZIP-Datei auswählen.',
    noAlbumName: 'Bitte einen Albumnamen eingeben.',
    readingZip: 'Lese ZIP-Datei...',
    zipEntriesFound: (n) => `-> ${n} Foto(s)/Video(s) in der ZIP gefunden.`,
    defaultZipAlbumName: 'Importiertes Album',
    albumAutoMatched: (name) => `➡ Ähnliches Album gefunden: "${name}" – Fotos werden dort ergänzt.`,
    noApiKeyShort: 'Kein API-Key hinterlegt.',
    subscriptionRunFailed: (m) => `Abo-Sync fehlgeschlagen: ${m}`,
  },
  en: {
    connecting: (url) => `Connecting to ${url} ...`,
    loadingTimeline: 'Loading photo list via the timeline buckets API...',
    bucketsFound: (n) => `-> Found ${n} time bucket(s) in the album. Loading contents...`,
    bucketParseError: (m) => `-> Error parsing bucket: ${m}`,
    timelineWarning: (m) => `-> Warning: timeline query failed: ${m}`,
    albumFound: (name, n) => `Album found: "${name}" with ${n} asset(s).`,
    noAssets: 'No assets found.',
    downloading: (id) => `Downloading asset ${id} ...`,
    actualFilename: (f) => `  -> actual filename: ${f}`,
    uploaded: '  ✓ uploaded',
    duplicate: '  ↺ already exists',
    assetError: (id, m) => `  ✗ Error for ${id}: ${m}`,
    done: (c, d, f) => `Done: ${c} new, ${d} already existed, ${f} failed.`,
    noApiKey: 'No Immich API key configured. Please add one in Settings first.',
    noShareUrl: 'Please provide a share link.',
    passwordRequired: 'This album is password-protected. Please enter the password in the form.',
    onlyHttp: 'Only http(s) links are allowed.',
    localBlocked: 'Local/internal addresses are not allowed as a share link.',
    noShareKey: 'Could not read a share key from the URL.',
    wrongPassword: 'Wrong password for the share link.',
    loginFailed: (s) => `Failed to log in to the share link (HTTP ${s}).`,
    shareInfoError: (s) => `Could not load album info (HTTP ${s}).`,
    downloadError: (s) => `Download failed (HTTP ${s}).`,
    uploadError: (s, tx) => `Upload failed (HTTP ${s}): ${tx}`,
    albumCreateError: (s) => `Failed to create album (HTTP ${s}).`,
    albumUpdateError: (s) => `Failed to update album (HTTP ${s}).`,
    invalidKey: 'Please enter a valid API key.',
    invalidUrl: 'Please enter a valid http(s) URL for your Immich instance.',
    keyRejected: (s) => `Immich rejected the key (HTTP ${s}). Please check it.`,
    googleDetected: 'Google Photos link detected (experimental).',
    googleScrapeFailed: (m) => `Automatic import failed: ${m}`,
    googleScrapeSuggestZip:
      "Automatic Google Photos import isn't reliably possible right now (Google has restricted access). " +
      'Please use "Download all" on the shared page instead and upload the resulting ZIP via the "Google Photos ZIP" tab.',
    defaultGoogleAlbumName: 'Google Photos album',
    noZipFile: 'Please select a ZIP file.',
    noAlbumName: 'Please enter an album name.',
    readingZip: 'Reading ZIP file...',
    zipEntriesFound: (n) => `-> Found ${n} photo(s)/video(s) in the ZIP.`,
    defaultZipAlbumName: 'Imported album',
    albumAutoMatched: (name) => `➡ Found a similar album: "${name}" – adding photos there.`,
    noApiKeyShort: 'No API key configured.',
    subscriptionRunFailed: (m) => `Subscription sync failed: ${m}`,
  },
};

function t(lang, key, ...args) {
  const dict = STRINGS[lang] || STRINGS.de;
  const entry = dict[key] ?? STRINGS.de[key];
  return typeof entry === 'function' ? entry(...args) : entry;
}

function resolveLang(body) {
  return body?.lang === 'en' ? 'en' : 'de';
}

// ---------- SSRF guard ----------

function isBlockedHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  if (net.isIP(h)) {
    if (/^127\./.test(h)) return true; // loopback
    if (/^10\./.test(h)) return true; // RFC1918
    if (/^192\.168\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    if (/^169\.254\./.test(h)) return true; // link-local / cloud metadata
    if (h === '0.0.0.0') return true;
  }
  return false;
}

function assertSafeUrl(urlString, lang) {
  const u = new URL(urlString);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(t(lang, 'onlyHttp'));
  if (isBlockedHost(u.hostname)) throw new Error(t(lang, 'localBlocked'));
  return u;
}

function parseShareUrl(shareUrl, lang) {
  const u = assertSafeUrl(shareUrl, lang);
  const token = u.pathname.split('/').filter(Boolean).pop();
  if (!token) throw new Error(t(lang, 'noShareKey'));
  return { baseUrl: `${u.protocol}//${u.host}`, token };
}

/** 'google' for Google Photos share links, 'immich' for everything else
 * (validated as an Immich share link further down the line anyway). */
function detectSource(shareUrl) {
  let hostname;
  try {
    hostname = new URL(shareUrl).hostname.toLowerCase();
  } catch {
    return 'immich';
  }
  if (hostname === 'photos.google.com' || hostname.endsWith('.photos.google.com')) return 'google';
  if (hostname === 'photos.app.goo.gl' || hostname === 'goo.gl') return 'google';
  return 'immich';
}

// ---------- media file helpers (shared by ZIP import & Google scraping) ----------

const MIME_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  m4v: 'video/x-m4v',
};
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'mkv', 'm4v']);

function isMediaFile(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return Object.prototype.hasOwnProperty.call(MIME_TYPES, ext);
}

async function tryGetExifDate(buffer) {
  try {
    const data = await exifr.parse(buffer, { pick: ['DateTimeOriginal', 'CreateDate'] });
    const d = data?.DateTimeOriginal || data?.CreateDate;
    if (d instanceof Date && !isNaN(d)) return d.toISOString();
  } catch {
    // Not every file has readable EXIF (e.g. videos, screenshots) - that's fine.
  }
  return null;
}

// ---------- local JSON stores ----------

async function readMappings() {
  try {
    return JSON.parse(await fs.readFile(MAPPINGS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

async function writeMappings(data) {
  await fs.mkdir(path.dirname(MAPPINGS_FILE), { recursive: true });
  await fs.writeFile(MAPPINGS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

async function readSubscriptions() {
  try {
    return JSON.parse(await fs.readFile(SUBSCRIPTIONS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

async function writeSubscriptions(list) {
  await fs.mkdir(path.dirname(SUBSCRIPTIONS_FILE), { recursive: true });
  await fs.writeFile(SUBSCRIPTIONS_FILE, JSON.stringify(list, null, 2), 'utf-8');
}

// ---------- encrypted settings store (Immich API key) ----------

function getEncryptionKey() {
  return Buffer.from(SETTINGS_ENCRYPTION_KEY_HEX, 'hex');
}

function encryptSecret(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  return {
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: encrypted.toString('hex'),
  };
}

function decryptSecret(enc) {
  const decipher = crypto.createDecipheriv(
    ENCRYPTION_ALGO,
    getEncryptionKey(),
    Buffer.from(enc.iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(enc.tag, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(enc.data, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf-8');
}

async function readSettings() {
  try {
    return JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

async function writeSettings(data) {
  await fs.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf-8');
  await fs.chmod(SETTINGS_FILE, 0o600).catch(() => {});
}

async function saveApiKey(plainKey) {
  const settings = await readSettings();
  settings.ownImmichApiKeyEnc = encryptSecret(plainKey);
  settings.updatedAt = new Date().toISOString();
  await writeSettings(settings);
  ownImmichApiKey = plainKey;
}

async function saveOwnImmichUrl(url) {
  const settings = await readSettings();
  settings.ownImmichUrl = url;
  settings.updatedAt = new Date().toISOString();
  await writeSettings(settings);
  OWN_IMMICH_URL = url;
}

async function loadApiKey() {
  const settings = await readSettings();

  // The Immich URL itself can also come from here instead of .env, so the
  // whole app can be started with zero configuration and set up entirely
  // through the Settings panel afterwards.
  if (!OWN_IMMICH_URL && settings.ownImmichUrl) {
    OWN_IMMICH_URL = settings.ownImmichUrl;
  }

  if (settings.ownImmichApiKeyEnc) {
    try {
      ownImmichApiKey = decryptSecret(settings.ownImmichApiKeyEnc);
      return;
    } catch (err) {
      console.error(
        'Could not decrypt stored API key (wrong/changed SETTINGS_ENCRYPTION_KEY?):',
        err.message
      );
    }
  }

  // One-time migration path for people upgrading from the .env-only version
  if (process.env.OWN_IMMICH_API_KEY) {
    await saveApiKey(process.env.OWN_IMMICH_API_KEY);
    console.log(
      'Picked up OWN_IMMICH_API_KEY from .env and stored it encrypted. You can remove it from .env now.'
    );
  }
}

async function verifyOwnApiKey(url, apiKey, lang) {
  const res = await fetch(`${url}/api/users/me`, {
    headers: { 'x-api-key': apiKey },
  });
  if (!res.ok) throw new Error(t(lang, 'keyRejected', res.status));
  const user = await res.json();
  return user.name || user.email || null;
}

// ---------- share-link client (friend's Immich instance) ----------

class ShareLinkClient {
  constructor(baseUrl, token, lang) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.lang = lang;
    this.paramName = 'key'; // corrected to 'slug' automatically if needed
    this.cookie = null;
  }

  buildUrl(pathname, extraParams = {}) {
    const u = new URL(this.baseUrl + pathname);
    u.searchParams.set(this.paramName, this.token);
    for (const [k, v] of Object.entries(extraParams)) {
      u.searchParams.set(k, v);
    }
    return u;
  }

  async rawFetch(url, options = {}) {
    const headers = {
      'x-immich-share-key': this.token,
      ...(options.headers || {}),
    };
    if (this.cookie) headers.Cookie = this.cookie;
    return fetch(url, { ...options, headers });
  }

  async fetchWithFallback(pathname, options = {}, extraParams = {}) {
    let res = await this.rawFetch(
      this.buildUrl(pathname, extraParams),
      options
    );

    if (res.status === 404 && this.paramName === 'key') {
      this.paramName = 'slug';
      res = await this.rawFetch(
        this.buildUrl(pathname, extraParams),
        options
      );
      if (!res.ok) this.paramName = 'key';
    }

    return res;
  }

  async login(password) {
    const res = await this.fetchWithFallback('/api/shared-links/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 400) {
        throw new Error(t(this.lang, 'wrongPassword'));
      }
      throw new Error(t(this.lang, 'loginFailed', res.status));
    }

    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    return res.json();
  }

  async getShareInfo() {
    const res = await this.fetchWithFallback('/api/shared-links/me');

    if (!res.ok) {
      if (res.status === 401) throw new Error('PASSWORD_REQUIRED');
      throw new Error(t(this.lang, 'shareInfoError', res.status));
    }

    return res.json();
  }

  async downloadOriginal(assetId) {
    const res = await this.fetchWithFallback(
      `/api/assets/${assetId}/original`
    );

    if (!res.ok) {
      throw new Error(t(this.lang, 'downloadError', res.status));
    }

    let filename = null;
    const disp = res.headers.get('content-disposition');

    if (disp) {
      const match = disp.match(
        /filename\*?=(?:UTF-8''|["]?)?([^;\r\n"']+)/i
      );
      if (match && match[1]) {
        filename = decodeURIComponent(match[1]);
      }
    }

    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      filename,
    };
  }
}

async function uploadToOwnImmich(buffer, asset, lang) {
  const form = new FormData();

  const ext = asset.isImage === false ? 'mp4' : 'jpg';
  const fileName =
    asset.originalFileName ||
    `Asset_${asset.id.slice(0, 8)}.${ext}`;
  const mimeType =
    asset.originalMimeType ||
    (asset.isImage === false ? 'video/mp4' : 'image/jpeg');

  form.append(
    'assetData',
    new Blob([buffer], { type: mimeType }),
    fileName
  );
  form.append('deviceId', 'immich-album-sync');
  form.append('deviceAssetId', asset.id || fileName);

  // Some share responses don't include fileCreatedAt directly - fall back
  // through whatever timestamp-ish field is available, and finally "now".
  let dateSource =
    asset.fileCreatedAt ||
    asset.localDateTime ||
    asset.createdAt ||
    asset.updatedAt;

  if (!dateSource && asset.timeBucket) {
    dateSource = `${asset.timeBucket}T12:00:00.000Z`;
  }

  let finalDate;

  try {
    finalDate = new Date(dateSource).toISOString();
  } catch {
    finalDate = new Date().toISOString();
  }

  form.append('fileCreatedAt', finalDate);
  form.append('fileModifiedAt', finalDate);

  const res = await fetch(`${OWN_IMMICH_URL}/api/assets`, {
    method: 'POST',
    headers: { 'x-api-key': ownImmichApiKey },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(
      t(lang, 'uploadError', res.status, errText.slice(0, 150))
    );
  }

  const data = await res.json();

  return {
    id: data.id,
    created: res.status === 201,
  };
}

async function createOwnAlbum(albumName, assetIds, lang) {
  const res = await fetch(`${OWN_IMMICH_URL}/api/albums`, {
    method: 'POST',
    headers: {
      'x-api-key': ownImmichApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ albumName, assetIds }),
  });

  if (!res.ok) {
    throw new Error(t(lang, 'albumCreateError', res.status));
  }

  return res.json();
}

async function addAssetsToOwnAlbum(albumId, assetIds) {
  return fetch(`${OWN_IMMICH_URL}/api/albums/${albumId}/assets`, {
    method: 'PUT',
    headers: {
      'x-api-key': ownImmichApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ids: assetIds }),
  });
}

async function getOwnAlbums() {
  const res = await fetch(`${OWN_IMMICH_URL}/api/albums`, {
    headers: { 'x-api-key': ownImmichApiKey },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const albums = await res.json();

  return albums.map((a) => ({
    id: a.id,
    albumName: a.albumName,
    assetCount: a.assetCount ?? null,
  }));
}

// ---------- existing-album name matching (for the "add to existing album" feature) ----------

function normalizeAlbumName(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function albumNameSimilarity(a, b) {
  const na = normalizeAlbumName(a);
  const nb = normalizeAlbumName(b);

  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;

  const setA = new Set(na.split(' '));
  const setB = new Set(nb.split(' '));
  const intersection = [...setA].filter((w) => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;

  return union ? intersection / union : 0;
}

const AUTO_MATCH_THRESHOLD = 0.6;

/** Best-matching existing album for a given name, or null if nothing is close enough. */
async function findMatchingAlbum(albumName) {
  const albums = await getOwnAlbums();
  let best = null;

  for (const album of albums) {
    const score = albumNameSimilarity(albumName, album.albumName);

    if (
      score >= AUTO_MATCH_THRESHOLD &&
      (!best || score > best.score)
    ) {
      best = { ...album, score };
    }
  }

  return best;
}

async function notifyHomeAssistant(payload) {
  if (!HOME_ASSISTANT_WEBHOOK_URL) return;

  try {
    await fetch(HOME_ASSISTANT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'immich_album_sync_completed',
        timestamp: new Date().toISOString(),
        ...payload,
      }),
    });
  } catch (err) {
    console.error('Home Assistant webhook failed:', err.message);
  }
}

/**
 * Shared upload+album logic used by the Immich-share, Google-scrape and
 * ZIP-import flows alike (both manual and subscription-triggered).
 * `downloadFn(asset)` must resolve to `{ buffer, filename }` (filename may
 * be null to keep the asset's own).
 *
 * `targetAlbumId` controls which album new photos land in when importMode
 * is 'album':
 *  - 'new'            -> always create a fresh album, ignore any match
 *  - a real album id  -> merge into that specific existing album
 *  - anything else / undefined ('auto') -> reuse the album from a previous
 *    sync of this exact source if known, otherwise try to auto-match an
 *    existing album by name, otherwise create a new one
 *
 * Always records a history entry in album-mappings.json (used by both the
 * history/re-sync list and the auto-match/reuse logic above), regardless
 * of import mode.
 */
async function importAssets({
  assets,
  downloadFn,
  albumName,
  importMode,
  mapKey,
  sourceType,
  sourceUrl,
  targetAlbumId,
  lang,
  log,
  send,
}) {
  const mappings = await readMappings();
  let ownAlbumId = null;

  if (importMode === 'album') {
    if (
      targetAlbumId &&
      targetAlbumId !== 'auto' &&
      targetAlbumId !== 'new'
    ) {
      ownAlbumId = targetAlbumId;
    } else if (targetAlbumId !== 'new') {
      ownAlbumId = mappings?.[mapKey]?.ownAlbumId || null;

      if (!ownAlbumId) {
        try {
          const match = await findMatchingAlbum(albumName);

          if (match) {
            ownAlbumId = match.id;
            log(t(lang, 'albumAutoMatched', match.albumName));
          }
        } catch {
          // If listing albums fails for some reason, just fall through to creating a new one.
        }
      }
    }
  }

  const targetAssetIds = [];
  let created = 0;
  let duplicates = 0;
  let failed = 0;
  let processed = 0;

  send({ type: 'total', total: assets.length });

  for (const asset of assets) {
    try {
      log(t(lang, 'downloading', String(asset.id).slice(0, 8)));

      const downloaded = await downloadFn(asset);

      if (downloaded.filename) {
        asset.originalFileName = downloaded.filename;
        log(t(lang, 'actualFilename', downloaded.filename));
      }

      const result = await uploadToOwnImmich(
        downloaded.buffer,
        asset,
        lang
      );

      targetAssetIds.push(result.id);

      if (result.created) {
        created++;
        log(t(lang, 'uploaded'));
      } else {
        duplicates++;
        log(t(lang, 'duplicate'));
      }
    } catch (err) {
      failed++;
      log(t(lang, 'assetError', asset.id, err.message));
    } finally {
      processed++;
      send({
        type: 'progress',
        current: processed,
        total: assets.length,
      });
    }
  }

  if (importMode === 'album' && targetAssetIds.length > 0) {
    if (ownAlbumId) {
      const putRes = await addAssetsToOwnAlbum(
        ownAlbumId,
        targetAssetIds
      );

      if (putRes.status === 404) {
        ownAlbumId = null;
      } else if (!putRes.ok) {
        throw new Error(
          t(lang, 'albumUpdateError', putRes.status)
        );
      }
    }

    if (!ownAlbumId) {
      ownAlbumId = (
        await createOwnAlbum(albumName, targetAssetIds, lang)
      ).id;
    }
  }

  if (mapKey) {
    mappings[mapKey] = {
      albumName,
      mode: importMode,
      ownAlbumId: importMode === 'album' ? ownAlbumId : null,
      sourceType: sourceType || null,
      sourceUrl: sourceUrl || null,
      lastSync: new Date().toISOString(),
      lastCreated: created,
      lastDuplicates: duplicates,
      lastFailed: failed,
    };

    await writeMappings(mappings);
  }

  log(t(lang, 'done', created, duplicates, failed));

  send({
    type: 'done',
    mode: importMode,
    albumId: importMode === 'album' ? ownAlbumId : undefined,
    created,
    duplicates,
    failed,
  });

  notifyHomeAssistant({
    albumName,
    mode: importMode,
    sourceType,
    created,
    duplicates,
    failed,
  }).catch(() => {});
}

// ---------- Google Photos (EXPERIMENTAL) ----------
//
// Google locked down the official Photos Library API for shared-album/
// third-party access in March 2025, and even community scraping tools were
// reportedly broken again by further changes as of March 2026. This is a
// best-effort attempt that scrapes the public share page for embedded
// lh3.googleusercontent.com image URLs. It can stop working at any time
// without warning - the ZIP-upload flow (/api/import-zip) is the reliable
// fallback and doesn't depend on any of this.

async function scrapeGooglePhotosAlbum(shareUrl, lang) {
  const res = await fetch(shareUrl, {
    redirect: 'follow',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; immich-album-sync)',
    },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html = await res.text();

  let albumName = null;
  const titleMatch =
    html.match(
      /<meta property="og:title" content="([^"]+)"/i
    ) ||
    html.match(/<title>([^<]+)<\/title>/i);

  if (titleMatch) {
    albumName = titleMatch[1].trim();
  }

  const matches = [
    ...html.matchAll(
      /https:\/\/lh3\.googleusercontent\.com\/pw\/[A-Za-z0-9_-]+/g
    ),
  ];

  const uniqueUrls = [...new Set(matches.map((m) => m[0]))];

  if (uniqueUrls.length === 0) {
    throw new Error('no image URLs found in page');
  }

  const assets = uniqueUrls.map((url, i) => ({
    id: crypto
      .createHash('sha1')
      .update(url)
      .digest('hex')
      .slice(0, 16),
    originalFileName: `google-photo-${i + 1}.jpg`,
    originalMimeType: 'image/jpeg',
    isImage: true,
    fileCreatedAt: null,
    _sourceUrl: `${url}=d`,
  }));

  return {
    albumName,
    assets,
  };
}

async function downloadGoogleAsset(asset) {
  const res = await fetch(asset._sourceUrl);

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    filename: null,
  };
}

/**
 * Resolves a share URL (Immich or Google Photos) down to an album name +
 * asset list, without downloading/uploading anything. Used by both the
 * lightweight preview endpoint and the real import route, so the two never
 * drift out of sync. `log` is optional (subscriptions run silently).
 */
async function discoverShareContent(
  shareUrl,
  password,
  lang,
  log
) {
  assertSafeUrl(shareUrl, lang);

  if (detectSource(shareUrl) === 'google') {
    log?.(t(lang, 'googleDetected'));

    let scraped;

    try {
      scraped = await scrapeGooglePhotosAlbum(
        shareUrl,
        lang
      );
    } catch (err) {
      log?.(t(lang, 'googleScrapeFailed', err.message));
      throw new Error(t(lang, 'googleScrapeSuggestZip'));
    }

    const albumName =
      scraped.albumName ||
      t(lang, 'defaultGoogleAlbumName');

    return {
      sourceType: 'google',
      albumName,
      assets: scraped.assets,
      mapKey: `google::${shareUrl}`,
    };
  }

  const { baseUrl, token } = parseShareUrl(
    shareUrl,
    lang
  );

  log?.(t(lang, 'connecting', baseUrl));

  const client = new ShareLinkClient(
    baseUrl,
    token,
    lang
  );

  if (password) {
    await client.login(password);
  }

  let shareInfo;

  try {
    shareInfo = await client.getShareInfo();
  } catch (err) {
    throw err.message === 'PASSWORD_REQUIRED'
      ? new Error(t(lang, 'passwordRequired'))
      : err;
  }

  const albumName =
    shareInfo.album?.albumName ||
    `Shared album ${token.slice(0, 8)}`;

  let assets =
    shareInfo.album?.assets ||
    shareInfo.assets ||
    [];

  if (
    assets.length === 0 &&
    shareInfo.album?.id
  ) {
    log?.(t(lang, 'loadingTimeline'));

    try {
      const bucketsRes =
        await client.fetchWithFallback(
          '/api/timeline/buckets',
          {},
          {
            albumId: shareInfo.album.id,
            size: 'MONTH',
          }
        );

      if (bucketsRes.ok) {
        const buckets = await bucketsRes.json();

        log?.(
          t(lang, 'bucketsFound', buckets.length)
        );

        for (const b of buckets) {
          if (!b.timeBucket) continue;

          const bRes =
            await client.fetchWithFallback(
              '/api/timeline/bucket',
              {},
              {
                albumId: shareInfo.album.id,
                timeBucket: b.timeBucket,
                size: 'MONTH',
              }
            );

          if (!bRes.ok) continue;

          try {
            const bData = JSON.parse(
              await bRes.text()
            );

            let extracted = [];

            if (Array.isArray(bData)) {
              extracted = bData;
            } else if (
              bData &&
              Array.isArray(bData.assets)
            ) {
              extracted = bData.assets;
            } else if (
              bData &&
              typeof bData === 'object' &&
              Array.isArray(bData.id)
            ) {
              const count = bData.id.length;

              for (let i = 0; i < count; i++) {
                const singleAsset = {
                  timeBucket: b.timeBucket,
                };

                for (const key of Object.keys(bData)) {
                  singleAsset[key] =
                    Array.isArray(bData[key])
                      ? bData[key][i]
                      : bData[key];
                }

                extracted.push(singleAsset);
              }
            }

            if (extracted.length > 0) {
              assets.push(...extracted);
            }
          } catch (e) {
            log?.(
              t(
                lang,
                'bucketParseError',
                e.message
              )
            );
          }
        }
      }
    } catch (e) {
      log?.(
        t(
          lang,
          'timelineWarning',
          e.message
        )
      );
    }
  }

  return {
    sourceType: 'immich',
    albumName,
    assets,
    client,
    mapKey: `${baseUrl}::${token}`,
  };
}

// ---------- routes: settings ----------

app.get('/api/settings', async (req, res) => {
  res.json({
    ownImmichUrl: OWN_IMMICH_URL,
    apiKeySet: !!ownImmichApiKey,
  });
});

app.get('/api/albums', async (req, res) => {
  if (!ownImmichApiKey) {
    return res.json({ albums: [] });
  }

  try {
    const albums = await getOwnAlbums();

    albums.sort((a, b) =>
      a.albumName.localeCompare(b.albumName)
    );

    res.json({ albums });
  } catch (err) {
    res.status(502).json({
      error: err.message,
    });
  }
});

app.get('/api/history', async (req, res) => {
  const mappings = await readMappings();

  const items = Object.entries(mappings)
    .map(([mapKey, v]) => ({
      mapKey,
      ...v,
    }))
    .sort(
      (a, b) =>
        new Date(b.lastSync || 0) -
        new Date(a.lastSync || 0)
    );

  res.json({ items });
});

app.post(
  '/api/settings',
  requireSameOrigin,
  async (req, res) => {
    const lang = resolveLang(req.body);

    const urlInput = (
      req.body?.ownImmichUrl || ''
    )
      .trim()
      .replace(/\/+$/, '');

    const apiKeyInput = (
      req.body?.apiKey || ''
    ).trim();

    const effectiveUrl =
      urlInput || OWN_IMMICH_URL;

    const effectiveKey =
      apiKeyInput || ownImmichApiKey;

    if (!effectiveUrl) {
      return res.status(400).json({
        error: t(lang, 'invalidUrl'),
      });
    }

    try {
      const u = new URL(effectiveUrl);

      if (
        u.protocol !== 'http:' &&
        u.protocol !== 'https:'
      ) {
        throw new Error('bad protocol');
      }
    } catch {
      return res.status(400).json({
        error: t(lang, 'invalidUrl'),
      });
    }

    if (
      !effectiveKey ||
      effectiveKey.length < 10
    ) {
      return res.status(400).json({
        error: t(lang, 'invalidKey'),
      });
    }

    try {
      const connectedAs =
        await verifyOwnApiKey(
          effectiveUrl,
          effectiveKey,
          lang
        );

      if (urlInput) {
        await saveOwnImmichUrl(effectiveUrl);
      }

      if (apiKeyInput) {
        await saveApiKey(effectiveKey);
      }

      res.json({
        success: true,
        connectedAs,
        ownImmichUrl: effectiveUrl,
      });
    } catch (err) {
      res.status(400).json({
        error: err.message,
      });
    }
  }
);

// ---------- route: preview (used before the real import to show thumbnails + target album) ----------

const PREVIEW_COUNT = 8;

app.post(
  '/api/preview',
  requireSameOrigin,
  async (req, res) => {
    const lang = resolveLang(req.body);

    try {
      if (!ownImmichApiKey) {
        throw new Error(
          t(lang, 'noApiKey')
        );
      }

      const {
        shareUrl,
        password,
        mode,
        targetAlbumId,
      } = req.body || {};

      if (!shareUrl) {
        throw new Error(
          t(lang, 'noShareUrl')
        );
      }

      const discovered =
        await discoverShareContent(
          shareUrl,
          password,
          lang,
          null
        );

      const thumbnails =
        discovered.sourceType === 'google'
          ? discovered.assets
              .slice(0, PREVIEW_COUNT)
              .map((a) => ({
                url: a._sourceUrl.replace(
                  /=d$/,
                  '=w300-h300'
                ),
                filename: null,
              }))
          : discovered.assets
              .slice(0, PREVIEW_COUNT)
              .map((a) => ({
                url: discovered.client
                  .buildUrl(
                    `/api/assets/${a.id}/thumbnail`
                  )
                  .toString(),
                filename:
                  a.originalFileName ||
                  null,
              }));

      let suggestedAlbum = null;

      const importMode =
        mode === 'photosOnly'
          ? 'photosOnly'
          : 'album';

      if (
        importMode === 'album' &&
        (!targetAlbumId ||
          targetAlbumId === 'auto')
      ) {
        try {
          const match =
            await findMatchingAlbum(
              discovered.albumName
            );

          if (match) {
            suggestedAlbum = {
              id: match.id,
              albumName:
                match.albumName,
            };
          }
        } catch {
          // Non-fatal - the real import will just fall through to creating a new album.
        }
      }

      res.json({
        sourceType:
          discovered.sourceType,
        albumName:
          discovered.albumName,
        assetCount:
          discovered.assets.length,
        thumbnails,
        suggestedAlbum,
      });
    } catch (err) {
      res.status(400).json({
        error: err.message,
      });
    }
  }
);

const previewZipUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 4 * 1024 * 1024 * 1024,
  },
});

app.post(
  '/api/preview-zip',
  requireSameOrigin,
  previewZipUpload.single('zipFile'),
  async (req, res) => {
    const lang = resolveLang(req.body);

    try {
      if (!ownImmichApiKey) {
        throw new Error(
          t(lang, 'noApiKey')
        );
      }

      if (!req.file) {
        throw new Error(
          t(lang, 'noZipFile')
        );
      }

      let zip;

      try {
        zip = new AdmZip(
          req.file.buffer
        );
      } catch (err) {
        throw new Error(
          `ZIP: ${err.message}`
        );
      }

      const entries = zip
        .getEntries()
        .filter(
          (e) =>
            !e.isDirectory &&
            isMediaFile(e.entryName)
        );

      const thumbnails = [];

      for (const entry of entries.slice(
        0,
        PREVIEW_COUNT
      )) {
        const filename = path.basename(
          entry.entryName
        );

        const ext = path
          .extname(entry.entryName)
          .slice(1)
          .toLowerCase();

        if (
          VIDEO_EXTENSIONS.has(ext)
        ) {
          thumbnails.push({
            filename,
            isVideo: true,
          });
          continue;
        }

        const buffer =
          entry.getData();

        thumbnails.push({
          filename,
          dataUrl: `data:${
            MIME_TYPES[ext] ||
            'image/jpeg'
          };base64,${buffer.toString(
            'base64'
          )}`,
        });
      }

      const albumNameInput = (
        req.body.albumName || ''
      ).trim();

      const importMode =
        req.body.mode ===
        'photosOnly'
          ? 'photosOnly'
          : 'album';

      let suggestedAlbum = null;

      if (
        importMode === 'album' &&
        albumNameInput &&
        (!req.body.targetAlbumId ||
          req.body.targetAlbumId ===
            'auto')
      ) {
        try {
          const match =
            await findMatchingAlbum(
              albumNameInput
            );

          if (match) {
            suggestedAlbum = {
              id: match.id,
              albumName:
                match.albumName,
            };
          }
        } catch {
          // Non-fatal.
        }
      }

      res.json({
        assetCount:
          entries.length,
        thumbnails,
        suggestedAlbum,
      });
    } catch (err) {
      res.status(400).json({
        error: err.message,
      });
    }
  }
);

// ---------- route: sync ----------

app.post(
  '/api/sync',
  requireSameOrigin,
  async (req, res) => {
    res.writeHead(200, {
      'Content-Type':
        'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
    });

    const send = (obj) =>
      res.write(
        JSON.stringify(obj) + '\n'
      );

    const lang = resolveLang(
      req.body
    );

    const log = (message) =>
      send({
        type: 'log',
        message,
      });

    try {
      if (!ownImmichApiKey) {
        throw new Error(
          t(lang, 'noApiKey')
        );
      }

      const {
        shareUrl,
        password,
        mode,
        targetAlbumId,
      } = req.body || {};

      if (!shareUrl) {
        throw new Error(
          t(lang, 'noShareUrl')
        );
      }

      const importMode =
        mode === 'photosOnly'
          ? 'photosOnly'
          : 'album';

      const discovered =
        await discoverShareContent(
          shareUrl,
          password,
          lang,
          log
        );

      log(
        t(
          lang,
          'albumFound',
          discovered.albumName,
          discovered.assets.length
        )
      );

      if (
        discovered.assets.length === 0
      ) {
        log(t(lang, 'noAssets'));

        send({
          type: 'done',
          created: 0,
          duplicates: 0,
          failed: 0,
        });

        return res.end();
      }

      const downloadFn =
        discovered.sourceType ===
        'google'
          ? downloadGoogleAsset
          : async (asset) =>
              discovered.client.downloadOriginal(
                asset.id
              );

      await importAssets({
        assets:
          discovered.assets,
        downloadFn,
        albumName:
          discovered.albumName,
        importMode,
        mapKey:
          discovered.mapKey,
        sourceType:
          discovered.sourceType,
        sourceUrl: shareUrl,
        targetAlbumId,
        lang,
        log,
        send,
      });

      res.end();
    } catch (err) {
      send({
        type: 'error',
        message: err.message,
      });

      res.end();
    }
  }
);

// ---------- route: Google Photos ZIP import (reliable fallback) ----------

const zipUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 4 * 1024 * 1024 * 1024,
  },
});

app.post(
  '/api/import-zip',
  requireSameOrigin,
  zipUpload.single('zipFile'),
  async (req, res) => {
    res.writeHead(200, {
      'Content-Type':
        'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
    });

    const send = (obj) =>
      res.write(
        JSON.stringify(obj) + '\n'
      );

    const lang = resolveLang(
      req.body
    );

    const log = (message) =>
      send({
        type: 'log',
        message,
      });

    try {
      if (!ownImmichApiKey) {
        throw new Error(
          t(lang, 'noApiKey')
        );
      }

      if (!req.file) {
        throw new Error(
          t(lang, 'noZipFile')
        );
      }

      const importMode =
        req.body.mode ===
        'photosOnly'
          ? 'photosOnly'
          : 'album';

      const albumNameInput = (
        req.body.albumName || ''
      ).trim();

      if (
        importMode === 'album' &&
        !albumNameInput
      ) {
        throw new Error(
          t(lang, 'noAlbumName')
        );
      }

      log(t(lang, 'readingZip'));

      let zip;

      try {
        zip = new AdmZip(
          req.file.buffer
        );
      } catch (err) {
        throw new Error(
          `ZIP: ${err.message}`
        );
      }

      const entries = zip
        .getEntries()
        .filter(
          (e) =>
            !e.isDirectory &&
            isMediaFile(e.entryName)
        );

      log(
        t(
          lang,
          'zipEntriesFound',
          entries.length
        )
      );

      if (entries.length === 0) {
        log(t(lang, 'noAssets'));

        send({
          type: 'done',
          created: 0,
          duplicates: 0,
          failed: 0,
        });

        return res.end();
      }

      const assets = [];

      for (const entry of entries) {
        const buffer =
          entry.getData();

        const ext = path
          .extname(entry.entryName)
          .slice(1)
          .toLowerCase();

        const exifDate =
          await tryGetExifDate(
            buffer
          );

        const zipDate =
          entry.header?.time
            ? new Date(
                entry.header.time
              ).toISOString()
            : null;

        assets.push({
          id: crypto
            .createHash('sha1')
            .update(entry.entryName)
            .digest('hex')
            .slice(0, 16),
          originalFileName:
            path.basename(
              entry.entryName
            ),
          originalMimeType:
            MIME_TYPES[ext] ||
            'application/octet-stream',
          isImage:
            !VIDEO_EXTENSIONS.has(
              ext
            ),
          fileCreatedAt:
            exifDate || zipDate,
          _buffer: buffer,
        });
      }

      await importAssets({
        assets,
        downloadFn: async (
          asset
        ) => ({
          buffer:
            asset._buffer,
          filename: null,
        }),
        albumName:
          albumNameInput ||
          t(
            lang,
            'defaultZipAlbumName'
          ),
        importMode,
        mapKey: `zip::${
          albumNameInput.toLowerCase() ||
          'unnamed'
        }`,
        sourceType: 'zip',
        sourceUrl: null,
        targetAlbumId:
          req.body
            .targetAlbumId,
        lang,
        log,
        send,
      });

      res.end();
    } catch (err) {
      send({
        type: 'error',
        message: err.message,
      });

      res.end();
    }
  }
);

// ---------- routes: subscriptions (auto-repeat sync) ----------

app.get(
  '/api/subscriptions',
  async (req, res) => {
    const subs =
      await readSubscriptions();

    res.json({
      subscriptions: subs,
    });
  }
);

app.post(
  '/api/subscriptions',
  requireSameOrigin,
  async (req, res) => {
    const lang = resolveLang(
      req.body
    );

    const {
      shareUrl,
      mode,
      targetAlbumId,
      intervalMinutes,
    } = req.body || {};

    if (!shareUrl) {
      return res
        .status(400)
        .json({
          error: t(
            lang,
            'noShareUrl'
          ),
        });
    }

    try {
      assertSafeUrl(
        shareUrl,
        lang
      );
    } catch (err) {
      return res
        .status(400)
        .json({
          error: err.message,
        });
    }

    const interval = Math.max(
      15,
      Number(intervalMinutes) || 60
    );

    const subs =
      await readSubscriptions();

    const sub = {
      id: crypto.randomUUID(),
      shareUrl,
      mode:
        mode === 'photosOnly'
          ? 'photosOnly'
          : 'album',
      targetAlbumId:
        targetAlbumId || 'auto',
      intervalMinutes:
        interval,
      enabled: true,
      createdAt:
        new Date().toISOString(),
      lastRun: null,
      lastResult: null,
    };

    subs.push(sub);

    await writeSubscriptions(
      subs
    );

    res.json({
      subscription: sub,
    });
  }
);

app.patch(
  '/api/subscriptions/:id',
  requireSameOrigin,
  async (req, res) => {
    const subs =
      await readSubscriptions();

    const sub = subs.find(
      (s) =>
        s.id === req.params.id
    );

    if (!sub) {
      return res
        .status(404)
        .json({
          error: 'not found',
        });
    }

    if (
      typeof req.body?.enabled ===
      'boolean'
    ) {
      sub.enabled =
        req.body.enabled;
    }

    if (
      req.body?.intervalMinutes
    ) {
      sub.intervalMinutes =
        Math.max(
          15,
          Number(
            req.body
              .intervalMinutes
          )
        );
    }

    await writeSubscriptions(
      subs
    );

    res.json({
      subscription: sub,
    });
  }
);

app.delete(
  '/api/subscriptions/:id',
  requireSameOrigin,
  async (req, res) => {
    const subs =
      await readSubscriptions();

    const filtered = subs.filter(
      (s) =>
        s.id !== req.params.id
    );

    await writeSubscriptions(
      filtered
    );

    res.json({
      success: true,
    });
  }
);

/**
 * Runs one subscription's sync right now.
 * Used both by the manual "run now" button
 * (streamed) and the background scheduler
 * (silent).
 */
async function runSubscriptionSync(
  sub,
  lang,
  log,
  send
) {
  if (!ownImmichApiKey) {
    throw new Error(
      t(lang, 'noApiKeyShort')
    );
  }

  const discovered =
    await discoverShareContent(
      sub.shareUrl,
      null,
      lang,
      log
    );

  if (
    discovered.assets.length === 0
  ) {
    send({
      type: 'done',
      created: 0,
      duplicates: 0,
      failed: 0,
    });

    return {
      created: 0,
      duplicates: 0,
      failed: 0,
    };
  }

  const downloadFn =
    discovered.sourceType ===
    'google'
      ? downloadGoogleAsset
      : async (asset) =>
          discovered.client.downloadOriginal(
            asset.id
          );

  let finalCounts = {
    created: 0,
    duplicates: 0,
    failed: 0,
  };

  const wrappedSend = (obj) => {
    if (obj.type === 'done') {
      finalCounts = {
        created:
          obj.created,
        duplicates:
          obj.duplicates,
        failed:
          obj.failed,
      };
    }

    send(obj);
  };

  await importAssets({
    assets:
      discovered.assets,
    downloadFn,
    albumName:
      discovered.albumName,
    importMode: sub.mode,
    mapKey:
      discovered.mapKey,
    sourceType:
      discovered.sourceType,
    sourceUrl: sub.shareUrl,
    targetAlbumId:
      sub.targetAlbumId,
    lang,
    log,
    send: wrappedSend,
  });

  return finalCounts;
}

app.post(
  '/api/subscriptions/:id/run',
  requireSameOrigin,
  async (req, res) => {
    const lang = resolveLang(
      req.body
    );

    const subs =
      await readSubscriptions();

    const sub = subs.find(
      (s) =>
        s.id === req.params.id
    );

    if (!sub) {
      return res
        .status(404)
        .end();
    }

    res.writeHead(200, {
      'Content-Type':
        'application/x-ndjson; charset=utf-8',
      'Cache-Control':
        'no-cache',
    });

    const send = (obj) =>
      res.write(
        JSON.stringify(obj) +
          '\n'
      );

    const log = (message) =>
      send({
        type: 'log',
        message,
      });

    try {
      const result =
        await runSubscriptionSync(
          sub,
          lang,
          log,
          send
        );

      sub.lastRun =
        new Date().toISOString();

      sub.lastResult = {
        ...result,
        error: null,
      };

      await writeSubscriptions(
        subs
      );
    } catch (err) {
      sub.lastRun =
        new Date().toISOString();

      sub.lastResult = {
        created: 0,
        duplicates: 0,
        failed: 0,
        error: err.message,
      };

      await writeSubscriptions(
        subs
      );

      send({
        type: 'error',
        message: err.message,
      });
    }

    res.end();
  }
);

// Background scheduler: checks once a minute whether any enabled
// subscription is due, and if so, runs it silently (console-only log).
let schedulerRunning = false;

async function checkSubscriptionsDue() {
  if (schedulerRunning) return;

  schedulerRunning = true;

  try {
    const subs =
      await readSubscriptions();

    const now = Date.now();
    let changed = false;

    for (const sub of subs) {
      if (!sub.enabled) continue;

      const dueAt = sub.lastRun
        ? new Date(
            sub.lastRun
          ).getTime() +
          sub.intervalMinutes *
            60000
        : 0;

      if (now < dueAt) {
        continue;
      }

      const consoleLog = (m) =>
        console.log(
          `[subscription ${sub.id.slice(
            0,
            8
          )}] ${m}`
        );

      try {
        const result =
          await runSubscriptionSync(
            sub,
            'de',
            consoleLog,
            () => {}
          );

        sub.lastRun =
          new Date().toISOString();

        sub.lastResult = {
          ...result,
          error: null,
        };
      } catch (err) {
        sub.lastRun =
          new Date().toISOString();

        sub.lastResult = {
          created: 0,
          duplicates: 0,
          failed: 0,
          error: err.message,
        };

        console.error(
          `[subscription ${sub.id.slice(
            0,
            8
          )}] failed:`,
          err.message
        );
      }

      changed = true;
    }

    if (changed) {
      await writeSubscriptions(
        subs
      );
    }
  } finally {
    schedulerRunning = false;
  }
}

setInterval(
  checkSubscriptionsDue,
  60 * 1000
);

auth
  .initialize()
  .then(() => {
    SETTINGS_ENCRYPTION_KEY_HEX =
      auth.getEncryptionKey();

    return loadApiKey();
  })
  .then(() => {
    app.listen(PORT, () => {
      console.log(
        `Immich Album Sync running at http://localhost:${PORT}`
      );

      if (
        !OWN_IMMICH_URL ||
        !ownImmichApiKey
      ) {
        console.log(
          'Note: Immich URL/API key not fully configured yet - open the web UI and use the Settings panel.'
        );
      }

      checkSubscriptionsDue();
    });
  })
  .catch((err) => {
    console.error(
      'Startup error:',
      err.message
    );
    process.exit(1);
  });
