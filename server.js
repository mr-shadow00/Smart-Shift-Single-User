const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const META_FILE = path.join(DATA_DIR, 'meta.json');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');
const WEEKS_DIR = path.join(DATA_DIR, 'weeks');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const APP_PASSWORD = process.env.APP_PASSWORD || ''; // optional: fix the password via env instead of the web UI
const SESSION_DAYS = 30;
const LEGACY_DATA_FILE = path.join(DATA_DIR, 'data.json'); // old single-file format

// Auto-backup: how many rotating backups to keep on disk at once. Oldest is
// deleted as soon as a new one is created past this count.
const MAX_BACKUPS = 3;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(WEEKS_DIR)) fs.mkdirSync(WEEKS_DIR, { recursive: true });
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });

// ── helpers ──
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJSONAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Sunday-start week key (the YYYY-MM-DD of that week's Sunday) for a given date string
function weekKeyFor(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() - d.getDay());
  return fmtDate(d);
}
function weekFile(weekStart) {
  const safe = String(weekStart).replace(/[^0-9-]/g, '');
  return path.join(WEEKS_DIR, safe + '.json');
}
function readWeek(weekStart) {
  return readJSON(weekFile(weekStart), { assignments: [], dayNotes: {} });
}
function writeWeek(weekStart, weekData) {
  writeJSONAtomic(weekFile(weekStart), weekData);
}

// ── meta: user profile + shift type definitions. Always small, always loaded. ──
if (!fs.existsSync(META_FILE)) writeJSONAtomic(META_FILE, { user: null, shifts: [], backup: { intervalDays: 5, lastBackupAt: null } });
function readMeta() {
  const m = readJSON(META_FILE, { user: null, shifts: [] });
  if (!m.backup) m.backup = { intervalDays: 5, lastBackupAt: null };
  return m;
}

// ── index: {date: {s:[shiftIds], n:bool}} — tiny, powers calendar dots/note
// icons across all dates without ever pulling in note text or photos. ──
function readIndex() { return readJSON(INDEX_FILE, {}); }
function writeIndex(idx) { writeJSONAtomic(INDEX_FILE, idx); }

// Recomputes index entries for exactly the 7 dates covered by one week's saved data
function updateIndexForWeek(weekStart, weekData) {
  const idx = readIndex();
  const start = new Date(weekStart + 'T00:00:00');
  for (let i = 0; i < 7; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const ds = fmtDate(d);
    const assigns = (weekData.assignments || []).filter(a => a.date === ds);
    const shiftIds = [...new Set(assigns.map(a => a.shiftId))];
    const note = weekData.dayNotes && weekData.dayNotes[ds];
    const hasNote = !!(note && (typeof note === 'string' ? note : (note.text || (note.photos && note.photos.length))));
    if (shiftIds.length || hasNote) idx[ds] = { s: shiftIds, n: hasNote };
    else delete idx[ds];
  }
  writeIndex(idx);
}

// ── backups: full JSON snapshots, same shape as the manual "Download backup"
// export, so any backup here can be dragged into Restore from the Profile tab. ──
function listBackups() {
  try {
    return fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const st = fs.statSync(path.join(BACKUPS_DIR, f));
        return { filename: f, createdAt: st.mtime.toISOString(), size: st.size };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch (e) {
    return [];
  }
}
function buildSnapshot() {
  const meta = readMeta();
  const assignments = [];
  const dayNotes = {};
  fs.readdirSync(WEEKS_DIR).filter(f => f.endsWith('.json')).forEach(f => {
    const wd = readJSON(path.join(WEEKS_DIR, f), { assignments: [], dayNotes: {} });
    assignments.push(...(wd.assignments || []));
    Object.assign(dayNotes, wd.dayNotes || {});
  });
  return { user: meta.user, shifts: meta.shifts, assignments, dayNotes };
}
// Reads every full-quality photo file on disk and embeds it as base64 so a
// backup is one self-contained file — restoring it brings the actual photos
// back too, not just the small thumbnails already embedded in dayNotes.
function collectPhotoFiles() {
  try {
    return fs.readdirSync(PHOTOS_DIR).map(filename => {
      const buf = fs.readFileSync(path.join(PHOTOS_DIR, filename));
      return { filename, base64: buf.toString('base64') };
    });
  } catch (e) {
    console.error('Failed to collect photo files for backup:', e);
    return [];
  }
}
function buildFullSnapshot() {
  const snapshot = buildSnapshot();
  snapshot.photoFiles = collectPhotoFiles();
  return snapshot;
}
// Deletes oldest backups past MAX_BACKUPS so the folder never grows unbounded.
function pruneBackups() {
  const files = listBackups();
  files.slice(MAX_BACKUPS).forEach(f => {
    try { fs.unlinkSync(path.join(BACKUPS_DIR, f.filename)); } catch (e) {}
  });
}
function createBackup() {
  const snapshot = buildFullSnapshot();
  const payload = { type: 'shifts-backup', version: 3, exportedAt: new Date().toISOString(), data: snapshot };
  const stamp = payload.exportedAt.replace(/[:.]/g, '-');
  const filename = `backup_${stamp}.json`;
  writeJSONAtomic(path.join(BACKUPS_DIR, filename), payload);
  const meta = readMeta();
  meta.backup = meta.backup || {};
  meta.backup.lastBackupAt = payload.exportedAt;
  writeJSONAtomic(META_FILE, meta);
  pruneBackups();
  return filename;
}
// Runs on boot and on a periodic timer — creates a new backup only once the
// configured interval has actually elapsed since the last one.
function checkAutoBackup() {
  const meta = readMeta();
  const days = Number(meta.backup && meta.backup.intervalDays);
  if (!days || days <= 0) return; // auto-backup disabled
  if (!meta.backup.lastBackupAt) {
    // First run: nothing to protect yet on a brand new install — just start the clock.
    meta.backup = meta.backup || {};
    meta.backup.lastBackupAt = new Date().toISOString();
    writeJSONAtomic(META_FILE, meta);
    return;
  }
  const elapsedMs = Date.now() - new Date(meta.backup.lastBackupAt).getTime();
  if (elapsedMs >= days * 24 * 60 * 60 * 1000) {
    try { createBackup(); console.log('Auto-backup created.'); }
    catch (e) { console.error('Auto-backup failed:', e); }
  }
}

// ── one-time migration from the old single data.json file, if present ──
(function migrateLegacyIfPresent() {
  if (!fs.existsSync(LEGACY_DATA_FILE)) return;
  try {
    const old = readJSON(LEGACY_DATA_FILE, null);
    if (!old) return;
    const existingBackup = readMeta().backup;
    writeJSONAtomic(META_FILE, { user: old.user || null, shifts: old.shifts || [], backup: existingBackup });
    const byWeek = {};
    (old.assignments || []).forEach(a => {
      const wk = weekKeyFor(a.date);
      (byWeek[wk] = byWeek[wk] || { assignments: [], dayNotes: {} }).assignments.push(a);
    });
    Object.entries(old.dayNotes || {}).forEach(([ds, note]) => {
      const wk = weekKeyFor(ds);
      (byWeek[wk] = byWeek[wk] || { assignments: [], dayNotes: {} }).dayNotes[ds] = note;
    });
    Object.entries(byWeek).forEach(([wk, wd]) => { writeWeek(wk, wd); updateIndexForWeek(wk, wd); });
    fs.renameSync(LEGACY_DATA_FILE, LEGACY_DATA_FILE + '.migrated');
    console.log('Migrated legacy data.json into per-week storage (renamed to data.json.migrated).');
  } catch (e) {
    console.error('Legacy migration failed:', e);
  }
})();

// ── request size + rate limiting ──
// 30mb comfortably covers a single full-quality phone photo as base64 (~33%
// larger than the raw file) without leaving the door wide open like a blanket
// 100mb limit did. Restoring a full backup can include many embedded photos
// at once though, so that one route gets a much higher ceiling.
const jsonParserNormal = express.json({ limit: '30mb' });
const jsonParserRestore = express.json({ limit: '500mb' });
app.use((req, res, next) => {
  if (req.path === '/api/restore') return jsonParserRestore(req, res, next);
  return jsonParserNormal(req, res, next);
});

// Lightweight in-memory rate limiter — no extra dependency needed for a
// single-user app. Tracks request counts per IP in a sliding window and
// resets the window once it expires. General cap protects the API as a
// whole; a tighter cap applies specifically to photo uploads since those
// are the most expensive requests (disk writes of large files).
function makeRateLimiter({ windowMs, max }) {
  const hits = new Map(); // ip -> { count, resetAt }
  // periodically drop stale entries so the map doesn't grow forever on a long-running server
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits.entries()) if (now > entry.resetAt) hits.delete(ip);
  }, windowMs).unref();
  return function (req, res, next) {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }
    entry.count++;
    if (entry.count > max) {
      const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: 'Too many requests — please slow down and try again shortly.' });
    }
    next();
  };
}

const generalLimiter = makeRateLimiter({ windowMs: 5 * 60 * 1000, max: 300 }); // 300 req / 5 min
const photoLimiter = makeRateLimiter({ windowMs: 5 * 60 * 1000, max: 30 });    // 30 uploads / 5 min

// ── login ──
// Password is created on first visit (or fixed via APP_PASSWORD). Stored as a
// scrypt hash in data/auth.json. Login = signed HttpOnly cookie, 30 days.
function readAuth() { return readJSON(AUTH_FILE, {}); }
function writeAuth(a) { writeJSONAtomic(AUTH_FILE, a); }
function sessionSecret() {
  const a = readAuth();
  if (!a.sessionSecret) { a.sessionSecret = crypto.randomBytes(32).toString('hex'); writeAuth(a); }
  return a.sessionSecret;
}
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function passwordConfigured() { return !!APP_PASSWORD || !!readAuth().passwordHash; }
function verifyPassword(pw) {
  if (APP_PASSWORD) return safeEqual(pw, APP_PASSWORD);
  const a = readAuth();
  if (!a.passwordHash) return false;
  const [salt, hash] = a.passwordHash.split(':');
  const test = crypto.scryptSync(pw, salt, 64);
  const real = Buffer.from(hash, 'hex');
  return real.length === test.length && crypto.timingSafeEqual(real, test);
}
function signSession() {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const sig = crypto.createHmac('sha256', sessionSecret()).update(String(exp)).digest('hex');
  return exp + '.' + sig;
}
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function hasSession(req) {
  const t = parseCookies(req).shifts_session;
  if (!t) return false;
  const [exp, sig] = t.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = crypto.createHmac('sha256', sessionSecret()).update(exp).digest('hex');
  return safeEqual(sig, expected);
}
function setSessionCookie(res) {
  res.setHeader('Set-Cookie', 'shifts_session=' + signSession() + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + SESSION_DAYS * 86400);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'shifts_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

// 10 failed logins per 15 minutes per IP
const failedLogins = new Map();
function loginBlocked(ip) {
  const r = failedLogins.get(ip);
  if (!r) return false;
  if (Date.now() - r.first > 15 * 60000) { failedLogins.delete(ip); return false; }
  return r.count >= 10;
}
function noteFailedLogin(ip) {
  const r = failedLogins.get(ip);
  if (!r || Date.now() - r.first > 15 * 60000) failedLogins.set(ip, { count: 1, first: Date.now() });
  else r.count++;
}

app.get('/api/auth/status', (req, res) => {
  res.json({ configured: passwordConfigured(), authed: hasSession(req), passwordFromEnv: !!APP_PASSWORD });
});
app.post('/api/auth/setup', (req, res) => {
  if (passwordConfigured()) return res.status(400).json({ error: 'Password is already set' });
  const pw = String((req.body && req.body.password) || '');
  if (pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const a = readAuth();
  a.passwordHash = hashPassword(pw);
  writeAuth(a);
  setSessionCookie(res);
  res.json({ ok: true });
});
app.post('/api/auth/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (loginBlocked(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const pw = String((req.body && req.body.password) || '');
  if (!passwordConfigured() || !verifyPassword(pw)) {
    noteFailedLogin(ip);
    return res.status(401).json({ error: 'Wrong password' });
  }
  failedLogins.delete(ip);
  setSessionCookie(res);
  res.json({ ok: true });
});
app.post('/api/auth/logout', (req, res) => { clearSessionCookie(res); res.json({ ok: true }); });
app.post('/api/auth/password', (req, res) => {
  if (!hasSession(req)) return res.status(401).json({ error: 'Not logged in' });
  if (APP_PASSWORD) return res.status(400).json({ error: 'Password is set by the APP_PASSWORD environment variable' });
  const { currentPassword, newPassword } = req.body || {};
  if (!verifyPassword(String(currentPassword || ''))) return res.status(401).json({ error: 'Current password is wrong' });
  if (String(newPassword || '').length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  const a = readAuth();
  a.passwordHash = hashPassword(String(newPassword));
  a.sessionSecret = crypto.randomBytes(32).toString('hex'); // logs out every other device
  writeAuth(a);
  setSessionCookie(res);
  res.json({ ok: true });
});

// Gate: everything else needs a login. Pages redirect to the login page, API returns 401.
const PUBLIC_FILES = ['/login.html', '/fonts.css', '/manifest.webmanifest', '/sw.js', '/icon.png', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png'];
app.use((req, res, next) => {
  if (hasSession(req)) return next();
  if (PUBLIC_FILES.includes(req.path) || req.path.startsWith('/fonts/')) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not logged in' });
  return res.redirect('/login.html');
});

app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use('/api', generalLimiter);
app.use('/api/photos', photoLimiter);
app.use(express.static(path.join(__dirname, 'public')));
// Serves the untouched full-quality photo originals. Filenames are
// server-generated, so this is safe to expose read-only.
app.use('/photos', express.static(PHOTOS_DIR, { maxAge: '365d', immutable: true }));

// ── meta: loaded once on boot, saved whenever profile or shift types change ──
app.get('/api/meta', (req, res) => { res.json(readMeta()); });
app.put('/api/meta', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Invalid payload' });
  try {
    const existingBackup = readMeta().backup;
    writeJSONAtomic(META_FILE, { user: body.user || null, shifts: body.shifts || [], backup: existingBackup });
    res.json({ ok: true });
  } catch (e) {
    console.error('Failed to save meta:', e);
    res.status(500).json({ error: 'Failed to save meta' });
  }
});

// ── index: tiny, loaded once on boot and re-polled cheaply — powers calendar dots ──
app.get('/api/index', (req, res) => { res.json(readIndex()); });

// ── one week's slice — the only place real content (notes, photo thumbnails) lives ──
app.get('/api/week/:start', (req, res) => {
  try { res.json(readWeek(req.params.start)); }
  catch (e) { console.error('Failed to read week:', e); res.status(500).json({ error: 'Failed to read week' }); }
});
app.put('/api/week/:start', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Invalid payload' });
  try {
    const weekData = { assignments: body.assignments || [], dayNotes: body.dayNotes || {} };
    writeWeek(req.params.start, weekData);
    updateIndexForWeek(req.params.start, weekData);
    res.json({ ok: true });
  } catch (e) {
    console.error('Failed to save week:', e);
    res.status(500).json({ error: 'Failed to save week' });
  }
});

// ── full merged snapshot — used ONLY on-demand for Summary/CSV, never on boot.
// Deliberately excludes photo file contents (kept lightweight for frequent use). ──
app.get('/api/all', (req, res) => {
  try {
    res.json(buildSnapshot());
  } catch (e) {
    console.error('Failed to read all data:', e);
    res.status(500).json({ error: 'Failed to read all data' });
  }
});

// ── summary totals — tiny reply for the Summary tab: how many times each shift
// was used, plus the grand total. The phone no longer downloads all history. ──
app.get('/api/summary', (req, res) => {
  try {
    const counts = {};
    let total = 0;
    fs.readdirSync(WEEKS_DIR).filter(f => f.endsWith('.json')).forEach(f => {
      const wd = readJSON(path.join(WEEKS_DIR, f), { assignments: [] });
      (wd.assignments || []).forEach(a => {
        counts[a.shiftId] = (counts[a.shiftId] || 0) + 1;
        total++;
      });
    });
    res.json({ counts, total });
  } catch (e) {
    console.error('Failed to build summary:', e);
    res.status(500).json({ error: 'Failed to build summary' });
  }
});

// ── full self-contained backup — same as /api/all, but embeds every photo
// file's contents too, so restoring this one file brings everything back:
// shifts, assignments, notes, and the actual pictures. ──
app.get('/api/backup/export', (req, res) => {
  try {
    res.json(buildFullSnapshot());
  } catch (e) {
    console.error('Failed to build full backup export:', e);
    res.status(500).json({ error: 'Failed to build full backup export' });
  }
});

// ── restore from a full backup file — splits it back into meta + per-week
// slices, and, if the backup includes embedded photo files, restores those
// to disk too so pictures come back along with everything else. ──
app.post('/api/restore', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || !Array.isArray(body.shifts)) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  try {
    const existingBackup = readMeta().backup;
    writeJSONAtomic(META_FILE, { user: body.user || null, shifts: body.shifts || [], backup: existingBackup });
    fs.readdirSync(WEEKS_DIR).forEach(f => fs.unlinkSync(path.join(WEEKS_DIR, f)));
    writeIndex({});
    const byWeek = {};
    (body.assignments || []).forEach(a => {
      const wk = weekKeyFor(a.date);
      (byWeek[wk] = byWeek[wk] || { assignments: [], dayNotes: {} }).assignments.push(a);
    });
    Object.entries(body.dayNotes || {}).forEach(([ds, note]) => {
      const wk = weekKeyFor(ds);
      (byWeek[wk] = byWeek[wk] || { assignments: [], dayNotes: {} }).dayNotes[ds] = note;
    });
    Object.entries(byWeek).forEach(([wk, wd]) => { writeWeek(wk, wd); updateIndexForWeek(wk, wd); });

    let restoredPhotos = 0;
    if (Array.isArray(body.photoFiles)) {
      // Backup includes actual photo files — treat it as the full picture and
      // replace what's on disk so old, no-longer-referenced photos don't linger.
      fs.readdirSync(PHOTOS_DIR).forEach(f => fs.unlinkSync(path.join(PHOTOS_DIR, f)));
      body.photoFiles.forEach(pf => {
        if (!pf || typeof pf.filename !== 'string' || typeof pf.base64 !== 'string') return;
        if (!/^[0-9-]+_\d+\.[a-zA-Z0-9]+$/.test(pf.filename)) return; // same safe-filename rule as uploads
        try {
          fs.writeFileSync(path.join(PHOTOS_DIR, pf.filename), Buffer.from(pf.base64, 'base64'));
          restoredPhotos++;
        } catch (e) { console.error('Failed to restore photo', pf.filename, e); }
      });
    }
    // else: an older-format backup with no embedded photos — leave whatever
    // photo files are already on disk untouched rather than wiping them out.

    res.json({ ok: true, restoredPhotos });
  } catch (e) {
    console.error('Failed to restore:', e);
    res.status(500).json({ error: 'Failed to restore' });
  }
});

// ── purge a shift type's assignments from every week file (not just the
// currently loaded one) — used when a shift type is deleted so no orphaned
// references linger in weeks the user isn't currently looking at. ──
app.delete('/api/shifts/:id/assignments', (req, res) => {
  const shiftId = String(req.params.id);
  try {
    const affected = [];
    fs.readdirSync(WEEKS_DIR).filter(f => f.endsWith('.json')).forEach(f => {
      const weekStart = f.replace(/\.json$/, '');
      const wd = readWeek(weekStart);
      const before = (wd.assignments || []).length;
      wd.assignments = (wd.assignments || []).filter(a => String(a.shiftId) !== shiftId);
      if (wd.assignments.length !== before) {
        writeWeek(weekStart, wd);
        updateIndexForWeek(weekStart, wd);
        affected.push(weekStart);
      }
    });
    res.json({ ok: true, affectedWeeks: affected });
  } catch (e) {
    console.error('Failed to purge shift assignments:', e);
    res.status(500).json({ error: 'Failed to purge shift assignments' });
  }
});


// place the full-quality image lives — the front end stores just a small
// compressed thumbnail in the week's data for the UI, and downloads pull
// the real file from here via the /photos static route above.
app.post('/api/photos', (req, res) => {
  try {
    const { date, dataUrl } = req.body || {};
    const match = typeof dataUrl === 'string' && dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: 'Invalid photo data' });
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    const buffer = Buffer.from(match[2], 'base64');
    const safeDate = (typeof date === 'string' ? date : 'unknown').replace(/[^0-9-]/g, '') || 'unknown';
    const filename = `${safeDate}_${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(PHOTOS_DIR, filename), buffer);
    res.json({ ok: true, filename });
  } catch (e) {
    console.error('Failed to save photo file:', e);
    res.status(500).json({ error: 'Failed to save photo file' });
  }
});

// Deletes a full-quality photo file from disk once it's removed from a note.
// Filename is restricted to the exact pattern the server itself generates
// (see POST /api/photos below), so this can't be used to escape PHOTOS_DIR.
app.delete('/api/photos/:filename', (req, res) => {
  const name = req.params.filename;
  if (!/^[0-9-]+_\d+\.[a-zA-Z0-9]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filePath = path.join(PHOTOS_DIR, name);
  if (path.dirname(filePath) !== PHOTOS_DIR) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (e) {
    console.error('Failed to delete photo file:', e);
    res.status(500).json({ error: 'Failed to delete photo file' });
  }
});

// ── auto-backup: settings + manual trigger + downloads ──
app.get('/api/backup', (req, res) => {
  const meta = readMeta();
  res.json({ intervalDays: meta.backup.intervalDays, lastBackupAt: meta.backup.lastBackupAt, backups: listBackups() });
});
app.put('/api/backup', (req, res) => {
  const body = req.body;
  const days = Number(body && body.intervalDays);
  if (!Number.isFinite(days) || days < 0 || days > 90) {
    return res.status(400).json({ error: 'intervalDays must be a number between 0 and 90 (0 disables auto-backup)' });
  }
  try {
    const meta = readMeta();
    meta.backup.intervalDays = days;
    writeJSONAtomic(META_FILE, meta);
    res.json({ ok: true, intervalDays: days, lastBackupAt: meta.backup.lastBackupAt, backups: listBackups() });
  } catch (e) {
    console.error('Failed to save backup settings:', e);
    res.status(500).json({ error: 'Failed to save backup settings' });
  }
});
app.post('/api/backup/run', (req, res) => {
  try {
    const filename = createBackup();
    const meta = readMeta();
    res.json({ ok: true, filename, lastBackupAt: meta.backup.lastBackupAt, backups: listBackups() });
  } catch (e) {
    console.error('Manual backup failed:', e);
    res.status(500).json({ error: 'Backup failed' });
  }
});
app.get('/api/backup/download/:filename', (req, res) => {
  const name = req.params.filename;
  if (!/^backup_[0-9T-]+\.json$/.test(name)) return res.status(400).json({ error: 'Invalid filename' });
  const filePath = path.join(BACKUPS_DIR, name);
  if (path.dirname(filePath) !== BACKUPS_DIR || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Backup not found' });
  }
  res.download(filePath, name);
});

app.listen(PORT, () => {
  console.log(`Shifts app listening on port ${PORT}`);
  checkAutoBackup();
  setInterval(checkAutoBackup, 60 * 60 * 1000).unref(); // re-check hourly for long-running servers
});
