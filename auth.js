import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const SESSION_COOKIE = 'immich_album_sync_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));

  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

function parseCookieHeader(header = '') {
  const result = {};

  for (const part of String(header).split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;

    const key = trimmed.slice(0, idx);
    const rawValue = trimmed.slice(idx + 1);

    try {
      result[key] = decodeURIComponent(rawValue);
    } catch {
      result[key] = rawValue;
    }
  }

  return result;
}

export function createAuth({
  credentialsFile,
  publicDir,
  encryptionKeyFromEnv = '',
  usernameFromEnv = '',
  passwordFromEnv = '',
  authLimiter,
  requireSameOrigin,
}) {
  let credentials = null;
  let encryptionKeyHex = '';
  let setupInProgress = false;
  const sessions = new Map();

  function isSetupComplete() {
    return Boolean(
      credentials?.username &&
      credentials?.passwordSalt &&
      credentials?.passwordHash
    );
  }

  async function saveCredentials(nextCredentials) {
    await fs.mkdir(path.dirname(credentialsFile), { recursive: true });
    await fs.writeFile(
      credentialsFile,
      JSON.stringify(nextCredentials, null, 2),
      'utf-8'
    );
    await fs.chmod(credentialsFile, 0o600).catch(() => {});
    credentials = nextCredentials;
  }

  async function buildStoredCredentials(username, password) {
    const passwordSalt = crypto.randomBytes(16).toString('hex');
    const passwordHash = (await scrypt(password, passwordSalt)).toString('hex');

    return {
      version: 2,
      username,
      passwordSalt,
      passwordHash,
      encryptionKey: encryptionKeyHex,
    };
  }

  async function initialize() {
    let stored = null;

    try {
      const raw = await fs.readFile(credentialsFile, 'utf-8');
      stored = JSON.parse(raw);
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        throw new Error(`credentials.json konnte nicht gelesen werden: ${err.message}`);
      }
    }

    encryptionKeyHex =
      encryptionKeyFromEnv ||
      stored?.encryptionKey ||
      crypto.randomBytes(32).toString('hex');

    if (!/^[0-9a-fA-F]{64}$/.test(encryptionKeyHex)) {
      throw new Error('SETTINGS_ENCRYPTION_KEY muss aus genau 64 Hex-Zeichen bestehen.');
    }

    const envUsername = String(usernameFromEnv || '').trim();
    const envPassword = String(passwordFromEnv || '');

    if ((envUsername && !envPassword) || (!envUsername && envPassword)) {
      throw new Error('APP_USERNAME und APP_PASSWORD müssen gemeinsam gesetzt werden.');
    }

    // Optionaler Headless-/Legacy-Modus über Umgebungsvariablen.
    if (envUsername && envPassword) {
      if (envUsername.length < 3 || envUsername.length > 64) {
        throw new Error('APP_USERNAME muss zwischen 3 und 64 Zeichen lang sein.');
      }
      if (envPassword.length < 12) {
        throw new Error('APP_PASSWORD muss mindestens 12 Zeichen lang sein.');
      }

      credentials = await buildStoredCredentials(envUsername, envPassword);
      await saveCredentials(credentials);
      return;
    }

    // Neues Format bereits vorhanden.
    if (stored?.username && stored?.passwordSalt && stored?.passwordHash) {
      credentials = {
        version: 2,
        username: stored.username,
        passwordSalt: stored.passwordSalt,
        passwordHash: stored.passwordHash,
        encryptionKey: encryptionKeyHex,
      };

      // Falls der Encryption-Key über ENV geändert wurde, Datei aktualisieren.
      if (stored.encryptionKey !== encryptionKeyHex || stored.version !== 2) {
        await saveCredentials(credentials);
      }
      return;
    }

    // Automatische Migration des bisherigen Klartext-Formats.
    if (stored?.username && stored?.password) {
      credentials = await buildStoredCredentials(stored.username, stored.password);
      await saveCredentials(credentials);
      console.log('Legacy login credentials were migrated to a password hash.');
      return;
    }

    // Frische Installation: nur den Encryption-Key speichern.
    // Benutzername/Passwort werden im Browser gewählt.
    credentials = {
      version: 2,
      encryptionKey: encryptionKeyHex,
    };
    await saveCredentials(credentials);
    console.log('First run: open the web UI to create the administrator account.');
  }

  function getEncryptionKey() {
    return encryptionKeyHex;
  }

  function getSession(req) {
    const cookies = parseCookieHeader(req.headers.cookie || '');
    const token = cookies[SESSION_COOKIE];
    if (!token) return null;

    const session = sessions.get(token);
    if (!session) return null;

    if (session.expiresAt <= Date.now()) {
      sessions.delete(token);
      return null;
    }

    return { token, ...session };
  }

  function createSession(username) {
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, {
      username,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    return token;
  }

  function setSessionCookie(req, res, token) {
    const secure = req.secure ? '; Secure' : '';
    const maxAge = Math.floor(SESSION_TTL_MS / 1000);

    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
    );
  }

  function clearSessionCookie(req, res) {
    const secure = req.secure ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
    );
  }

  function requireAuth(req, res, next) {
    const session = getSession(req);

    if (!session) {
      return res.status(401).json({ error: 'Nicht angemeldet.' });
    }

    req.auth = session;
    next();
  }

  async function verifyPassword(password) {
    if (!isSetupComplete()) return false;

    const candidateHash = (await scrypt(password, credentials.passwordSalt)).toString('hex');
    return timingSafeEqualStr(candidateHash, credentials.passwordHash);
  }

  function registerRoutes(app) {
    app.get('/api/auth/status', (req, res) => {
      const session = getSession(req);
      res.json({
        setupComplete: isSetupComplete(),
        authenticated: Boolean(session),
        username: session?.username || null,
      });
    });

    app.post('/api/setup', authLimiter, requireSameOrigin, async (req, res) => {
      if (isSetupComplete() || setupInProgress) {
        return res.status(409).json({ error: 'Die Ersteinrichtung wurde bereits abgeschlossen.' });
      }

      const username = String(req.body?.username || '').trim();
      const password = String(req.body?.password || '');
      const confirmPassword = String(req.body?.confirmPassword || '');

      if (!/^[\p{L}\p{N}._-]{3,64}$/u.test(username)) {
        return res.status(400).json({
          error: 'Der Benutzername muss 3–64 Zeichen lang sein und darf Buchstaben, Zahlen, Punkt, Unterstrich und Bindestrich enthalten.',
        });
      }

      if (password.length < 12) {
        return res.status(400).json({ error: 'Das Passwort muss mindestens 12 Zeichen lang sein.' });
      }

      if (password.length > 256) {
        return res.status(400).json({ error: 'Das Passwort ist zu lang.' });
      }

      if (password !== confirmPassword) {
        return res.status(400).json({ error: 'Die beiden Passwörter stimmen nicht überein.' });
      }

      setupInProgress = true;

      try {
        const nextCredentials = await buildStoredCredentials(username, password);
        await saveCredentials(nextCredentials);

        const token = createSession(username);
        setSessionCookie(req, res, token);

        res.json({ success: true });
      } catch (err) {
        console.error('Setup failed:', err);
        res.status(500).json({ error: 'Die Einrichtung konnte nicht gespeichert werden.' });
      } finally {
        setupInProgress = false;
      }
    });

    app.post('/api/login', authLimiter, requireSameOrigin, async (req, res) => {
      if (!isSetupComplete()) {
        return res.status(409).json({ error: 'Die Ersteinrichtung wurde noch nicht abgeschlossen.' });
      }

      const username = String(req.body?.username || '').trim();
      const password = String(req.body?.password || '');

      try {
        const usernameOk = timingSafeEqualStr(username, credentials.username);
        const passwordOk = await verifyPassword(password);

        if (!usernameOk || !passwordOk) {
          return res.status(401).json({ error: 'Benutzername oder Passwort ist falsch.' });
        }

        const token = createSession(credentials.username);
        setSessionCookie(req, res, token);

        res.json({ success: true });
      } catch (err) {
        console.error('Login failed:', err);
        res.status(500).json({ error: 'Anmeldung fehlgeschlagen.' });
      }
    });

    app.post('/api/logout', requireAuth, requireSameOrigin, (req, res) => {
      if (req.auth?.token) sessions.delete(req.auth.token);
      clearSessionCookie(req, res);
      res.json({ success: true });
    });

    app.get('/setup.html', (req, res) => {
      if (isSetupComplete()) {
        return res.redirect('/login.html');
      }
      res.sendFile(path.join(publicDir, 'setup.html'));
    });

    app.get('/login.html', (req, res) => {
      if (!isSetupComplete()) {
        return res.redirect('/setup.html');
      }

      if (getSession(req)) {
        return res.redirect('/');
      }

      res.sendFile(path.join(publicDir, 'login.html'));
    });

    const serveHome = (req, res) => {
      if (!isSetupComplete()) {
        return res.redirect('/setup.html');
      }

      if (!getSession(req)) {
        return res.redirect('/login.html');
      }

      res.sendFile(path.join(publicDir, 'index.html'));
    };

    app.get('/', serveHome);
    app.get('/index.html', serveHome);
  }

  // Abgelaufene Sessions regelmäßig entfernen.
  setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions.entries()) {
      if (session.expiresAt <= now) sessions.delete(token);
    }
  }, 60 * 60 * 1000).unref();

  return {
    initialize,
    getEncryptionKey,
    isSetupComplete,
    registerRoutes,
    requireAuth,
  };
}
