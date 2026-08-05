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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPPINGS_FILE = path.join(__dirname, 'data', 'album-mappings.json');
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
const ENCRYPTION_ALGO = 'aes-256-gcm';

const OWN_IMMICH_URL = (process.env.OWN_IMMICH_URL || '').replace(/\/+$/, '');
const APP_USERNAME = process.env.APP_USERNAME || '';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const PORT = process.env.PORT || 3050;

if (!OWN_IMMICH_URL || !APP_USERNAME || !APP_PASSWORD) {
  console.error('Please set OWN_IMMICH_URL, APP_USERNAME and APP_PASSWORD in .env (see .env.example).');
  process.exit(1);
}
if (APP_PASSWORD.length < 12) {
  console.error('APP_PASSWORD is too short/weak. Please use at least 12 random characters.');
  process.exit(1);
}
if (!/^[0-9a-fA-F]{64}$/.test(process.env.SETTINGS_ENCRYPTION_KEY || '')) {
  console.error(
    'Please set SETTINGS_ENCRYPTION_KEY in .env (64 hex chars / 32 bytes).\n' +
      'Generate one with:  openssl rand -hex 32'
  );
  process.exit(1);
}

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
  message: 'Too many attempts. Please try again later.',
});

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    const idx = decoded.indexOf(':');
    const user = idx === -1 ? decoded : decoded.slice(0, idx);
    const pass = idx === -1 ? '' : decoded.slice(idx + 1);
    if (timingSafeEqualStr(user, APP_USERNAME) && timingSafeEqualStr(pass, APP_PASSWORD)) {
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="Immich Album Sync"');
  res.status(401).send('Authentication required.');
}

// Browsers automatically attach cached Basic-Auth credentials to same-origin
// requests, even ones triggered by a different page. Reject anything that's
// clearly cross-site as a cheap CSRF guard.
function requireSameOrigin(req, res, next) {
  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return res.status(403).send('Cross-site requests are not allowed.');
  }
  next();
}

app.use(authLimiter);
app.use(requireAuth);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// ---------- encrypted settings store (Immich API key) ----------

function getEncryptionKey() {
  return Buffer.from(process.env.SETTINGS_ENCRYPTION_KEY, 'hex');
}
function encryptSecret(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  return { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: encrypted.toString('hex') };
}
function decryptSecret(enc) {
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGO, getEncryptionKey(), Buffer.from(enc.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(enc.tag, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(enc.data, 'hex')), decipher.final()]);
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

async function loadApiKey() {
  const settings = await readSettings();
  if (settings.ownImmichApiKeyEnc) {
    try {
      ownImmichApiKey = decryptSecret(settings.ownImmichApiKeyEnc);
      return;
    } catch (err) {
      console.error('Could not decrypt stored API key (wrong/changed SETTINGS_ENCRYPTION_KEY?):', err.message);
    }
  }
  // One-time migration path for people upgrading from the .env-only version
  if (process.env.OWN_IMMICH_API_KEY) {
    await saveApiKey(process.env.OWN_IMMICH_API_KEY);
    console.log('Picked up OWN_IMMICH_API_KEY from .env and stored it encrypted. You can remove it from .env now.');
  }
}

async function verifyOwnApiKey(apiKey, lang) {
  const res = await fetch(`${OWN_IMMICH_URL}/api/users/me`, { headers: { 'x-api-key': apiKey } });
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
    for (const [k, v] of Object.entries(extraParams)) u.searchParams.set(k, v);
    return u;
  }

  async rawFetch(url, options = {}) {
    const headers = { 'x-immich-share-key': this.token, ...(options.headers || {}) };
    if (this.cookie) headers['Cookie'] = this.cookie;
    return fetch(url, { ...options, headers });
  }

  async fetchWithFallback(pathname, options = {}, extraParams = {}) {
    let res = await this.rawFetch(this.buildUrl(pathname, extraParams), options);
    if (res.status === 404 && this.paramName === 'key') {
      this.paramName = 'slug';
      res = await this.rawFetch(this.buildUrl(pathname, extraParams), options);
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
      if (res.status === 401 || res.status === 400) throw new Error(t(this.lang, 'wrongPassword'));
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
    const res = await this.fetchWithFallback(`/api/assets/${assetId}/original`);
    if (!res.ok) throw new Error(t(this.lang, 'downloadError', res.status));

    let filename = null;
    const disp = res.headers.get('content-disposition');
    if (disp) {
      const match = disp.match(/filename\*?=(?:UTF-8''|["]?)?([^;\r\n"']+)/i);
      if (match && match[1]) filename = decodeURIComponent(match[1]);
    }
    return { buffer: Buffer.from(await res.arrayBuffer()), filename };
  }
}

async function uploadToOwnImmich(buffer, asset, lang) {
  const form = new FormData();

  const ext = asset.isImage === false ? 'mp4' : 'jpg';
  const fileName = asset.originalFileName || `Asset_${asset.id.slice(0, 8)}.${ext}`;
  const mimeType = asset.originalMimeType || (asset.isImage === false ? 'video/mp4' : 'image/jpeg');

  form.append('assetData', new Blob([buffer], { type: mimeType }), fileName);
  form.append('deviceId', 'immich-album-sync');
  form.append('deviceAssetId', asset.id || fileName);

  // Some share responses don't include fileCreatedAt directly - fall back
  // through whatever timestamp-ish field is available, and finally "now".
  let dateSource = asset.fileCreatedAt || asset.localDateTime || asset.createdAt || asset.updatedAt;
  if (!dateSource && asset.timeBucket) dateSource = `${asset.timeBucket}T12:00:00.000Z`;

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
    throw new Error(t(lang, 'uploadError', res.status, errText.slice(0, 150)));
  }
  const data = await res.json();
  return { id: data.id, created: res.status === 201 };
}

async function createOwnAlbum(albumName, assetIds, lang) {
  const res = await fetch(`${OWN_IMMICH_URL}/api/albums`, {
    method: 'POST',
    headers: { 'x-api-key': ownImmichApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ albumName, assetIds }),
  });
  if (!res.ok) throw new Error(t(lang, 'albumCreateError', res.status));
  return res.json();
}

async function addAssetsToOwnAlbum(albumId, assetIds) {
  return fetch(`${OWN_IMMICH_URL}/api/albums/${albumId}/assets`, {
    method: 'PUT',
    headers: { 'x-api-key': ownImmichApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: assetIds }),
  });
}

/**
 * Shared upload+album logic used by the Immich-share, Google-scrape and
 * ZIP-import flows alike. `downloadFn(asset)` must resolve to
 * `{ buffer, filename }` (filename may be null to keep the asset's own).
 */
async function importAssets({ assets, downloadFn, albumName, importMode, mapKey, lang, log, send }) {
  const mappings = importMode === 'album' ? await readMappings() : null;
  let ownAlbumId = mappings?.[mapKey]?.ownAlbumId || null;

  const targetAssetIds = [];
  let created = 0;
  let duplicates = 0;
  let failed = 0;

  for (const asset of assets) {
    try {
      log(t(lang, 'downloading', String(asset.id).slice(0, 8)));
      const downloaded = await downloadFn(asset);
      if (downloaded.filename) {
        asset.originalFileName = downloaded.filename;
        log(t(lang, 'actualFilename', downloaded.filename));
      }
      const result = await uploadToOwnImmich(downloaded.buffer, asset, lang);
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
    }
  }

  if (targetAssetIds.length === 0) {
    send({ type: 'done', created, duplicates, failed });
    return;
  }
  if (importMode === 'photosOnly') {
    log(t(lang, 'done', created, duplicates, failed));
    send({ type: 'done', mode: 'photosOnly', created, duplicates, failed });
    return;
  }

  if (ownAlbumId) {
    const putRes = await addAssetsToOwnAlbum(ownAlbumId, targetAssetIds);
    if (putRes.status === 404) ownAlbumId = null;
    else if (!putRes.ok) throw new Error(t(lang, 'albumUpdateError', putRes.status));
  }
  if (!ownAlbumId) {
    ownAlbumId = (await createOwnAlbum(albumName, targetAssetIds, lang)).id;
  }

  mappings[mapKey] = { ownAlbumId, albumName, lastSync: new Date().toISOString() };
  await writeMappings(mappings);

  log(t(lang, 'done', created, duplicates, failed));
  send({ type: 'done', albumId: ownAlbumId, created, duplicates, failed });
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
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; immich-album-sync)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  let albumName = null;
  const titleMatch =
    html.match(/<meta property="og:title" content="([^"]+)"/i) || html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) albumName = titleMatch[1].trim();

  // Google embeds each photo's base image URL as https://lh3.googleusercontent.com/pw/<id>
  // in the page's inline data. Appending "=d" requests the original file for download.
  const matches = [...html.matchAll(/https:\/\/lh3\.googleusercontent\.com\/pw\/[A-Za-z0-9_-]+/g)];
  const uniqueUrls = [...new Set(matches.map((m) => m[0]))];
  if (uniqueUrls.length === 0) throw new Error('no image URLs found in page');

  const assets = uniqueUrls.map((url, i) => ({
    id: crypto.createHash('sha1').update(url).digest('hex').slice(0, 16),
    originalFileName: `google-photo-${i + 1}.jpg`,
    originalMimeType: 'image/jpeg',
    isImage: true,
    fileCreatedAt: null,
    _sourceUrl: `${url}=d`,
  }));

  return { albumName, assets };
}

async function downloadGoogleAsset(asset) {
  const res = await fetch(asset._sourceUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { buffer: Buffer.from(await res.arrayBuffer()), filename: null };
}

// ---------- routes: settings ----------

app.get('/api/settings', async (req, res) => {
  res.json({ ownImmichUrl: OWN_IMMICH_URL, apiKeySet: !!ownImmichApiKey });
});

app.post('/api/settings', requireSameOrigin, async (req, res) => {
  const { apiKey } = req.body || {};
  const lang = resolveLang(req.body);
  if (typeof apiKey !== 'string' || apiKey.trim().length < 10) {
    return res.status(400).json({ error: t(lang, 'invalidKey') });
  }
  const trimmed = apiKey.trim();
  try {
    const connectedAs = await verifyOwnApiKey(trimmed, lang);
    await saveApiKey(trimmed);
    res.json({ success: true, connectedAs });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- route: sync ----------

app.post('/api/sync', requireSameOrigin, async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');
  const lang = resolveLang(req.body);
  const log = (message) => send({ type: 'log', message });

  try {
    if (!ownImmichApiKey) throw new Error(t(lang, 'noApiKey'));

    const { shareUrl, password, mode } = req.body || {};
    if (!shareUrl) throw new Error(t(lang, 'noShareUrl'));
    const importMode = mode === 'photosOnly' ? 'photosOnly' : 'album';

    assertSafeUrl(shareUrl, lang);

    if (detectSource(shareUrl) === 'google') {
      log(t(lang, 'googleDetected'));
      let scraped;
      try {
        scraped = await scrapeGooglePhotosAlbum(shareUrl, lang);
      } catch (err) {
        log(t(lang, 'googleScrapeFailed', err.message));
        throw new Error(t(lang, 'googleScrapeSuggestZip'));
      }
      const albumName = scraped.albumName || t(lang, 'defaultGoogleAlbumName');
      log(t(lang, 'albumFound', albumName, scraped.assets.length));

      await importAssets({
        assets: scraped.assets,
        downloadFn: downloadGoogleAsset,
        albumName,
        importMode,
        mapKey: `google::${shareUrl}`,
        lang,
        log,
        send,
      });
      return res.end();
    }

    const { baseUrl, token } = parseShareUrl(shareUrl, lang);
    log(t(lang, 'connecting', baseUrl));
    const client = new ShareLinkClient(baseUrl, token, lang);
    if (password) await client.login(password);

    let shareInfo;
    try {
      shareInfo = await client.getShareInfo();
    } catch (err) {
      throw err.message === 'PASSWORD_REQUIRED' ? new Error(t(lang, 'passwordRequired')) : err;
    }

    const albumName = shareInfo.album?.albumName || `Shared album ${token.slice(0, 8)}`;
    let assets = shareInfo.album?.assets || shareInfo.assets || [];

    // Some Immich versions don't inline assets in the share response - fall
    // back to walking the timeline-buckets API scoped to the album.
    if (assets.length === 0 && shareInfo.album?.id) {
      log(t(lang, 'loadingTimeline'));
      try {
        const bucketsRes = await client.fetchWithFallback('/api/timeline/buckets', {}, { albumId: shareInfo.album.id, size: 'MONTH' });
        if (bucketsRes.ok) {
          const buckets = await bucketsRes.json();
          log(t(lang, 'bucketsFound', buckets.length));

          for (const b of buckets) {
            if (!b.timeBucket) continue;
            const bRes = await client.fetchWithFallback('/api/timeline/bucket', {}, {
              albumId: shareInfo.album.id,
              timeBucket: b.timeBucket,
              size: 'MONTH',
            });
            if (!bRes.ok) continue;

            try {
              const bData = JSON.parse(await bRes.text());
              let extracted = [];
              if (Array.isArray(bData)) {
                extracted = bData;
              } else if (bData && Array.isArray(bData.assets)) {
                extracted = bData.assets;
              } else if (bData && typeof bData === 'object' && Array.isArray(bData.id)) {
                // Columnar response format: { id: [...], originalFileName: [...], ... }
                // -> transpose into one object per asset.
                const count = bData.id.length;
                for (let i = 0; i < count; i++) {
                  const singleAsset = { timeBucket: b.timeBucket };
                  for (const key of Object.keys(bData)) {
                    singleAsset[key] = Array.isArray(bData[key]) ? bData[key][i] : bData[key];
                  }
                  extracted.push(singleAsset);
                }
              }
              if (extracted.length > 0) assets.push(...extracted);
            } catch (e) {
              log(t(lang, 'bucketParseError', e.message));
            }
          }
        }
      } catch (e) {
        log(t(lang, 'timelineWarning', e.message));
      }
    }

    log(t(lang, 'albumFound', albumName, assets.length));
    if (assets.length === 0) {
      log(t(lang, 'noAssets'));
      send({ type: 'done', created: 0, duplicates: 0, failed: 0 });
      return res.end();
    }

    await importAssets({
      assets,
      downloadFn: async (asset) => client.downloadOriginal(asset.id),
      albumName,
      importMode,
      mapKey: `${baseUrl}::${token}`,
      lang,
      log,
      send,
    });
    res.end();
  } catch (err) {
    send({ type: 'error', message: err.message });
    res.end();
  }
});

// ---------- route: Google Photos ZIP import (reliable fallback) ----------

const zipUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 }, // 4GB - everything is buffered in memory
});

app.post('/api/import-zip', requireSameOrigin, zipUpload.single('zipFile'), async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');
  const lang = resolveLang(req.body);
  const log = (message) => send({ type: 'log', message });

  try {
    if (!ownImmichApiKey) throw new Error(t(lang, 'noApiKey'));
    if (!req.file) throw new Error(t(lang, 'noZipFile'));

    const importMode = req.body.mode === 'photosOnly' ? 'photosOnly' : 'album';
    const albumNameInput = (req.body.albumName || '').trim();
    if (importMode === 'album' && !albumNameInput) throw new Error(t(lang, 'noAlbumName'));

    log(t(lang, 'readingZip'));
    let zip;
    try {
      zip = new AdmZip(req.file.buffer);
    } catch (err) {
      throw new Error(`ZIP: ${err.message}`);
    }
    const entries = zip.getEntries().filter((e) => !e.isDirectory && isMediaFile(e.entryName));
    log(t(lang, 'zipEntriesFound', entries.length));

    if (entries.length === 0) {
      log(t(lang, 'noAssets'));
      send({ type: 'done', created: 0, duplicates: 0, failed: 0 });
      return res.end();
    }

    const assets = [];
    for (const entry of entries) {
      const buffer = entry.getData();
      const ext = path.extname(entry.entryName).slice(1).toLowerCase();
      const exifDate = await tryGetExifDate(buffer);
      const zipDate = entry.header?.time ? new Date(entry.header.time).toISOString() : null;
      assets.push({
        id: crypto.createHash('sha1').update(entry.entryName).digest('hex').slice(0, 16),
        originalFileName: path.basename(entry.entryName),
        originalMimeType: MIME_TYPES[ext] || 'application/octet-stream',
        isImage: !VIDEO_EXTENSIONS.has(ext),
        fileCreatedAt: exifDate || zipDate,
        _buffer: buffer,
      });
    }

    await importAssets({
      assets,
      downloadFn: async (asset) => ({ buffer: asset._buffer, filename: null }),
      albumName: albumNameInput || t(lang, 'defaultZipAlbumName'),
      importMode,
      mapKey: `zip::${albumNameInput.toLowerCase() || 'unnamed'}`,
      lang,
      log,
      send,
    });
    res.end();
  } catch (err) {
    send({ type: 'error', message: err.message });
    res.end();
  }
});

loadApiKey()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Immich Album Sync running at http://localhost:${PORT}`);
      if (!ownImmichApiKey) {
        console.log('Note: no Immich API key configured yet - add one via the Settings panel in the web UI.');
      }
    });
  })
  .catch((err) => {
    console.error('Startup error:', err.message);
    process.exit(1);
  });
