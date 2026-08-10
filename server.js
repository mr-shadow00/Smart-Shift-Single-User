const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const META_FILE = path.join(DATA_DIR, 'meta.json');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');
const WEEKS_DIR = path.join(DATA_DIR, 'weeks');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
const LEGACY_DATA_FILE = path.join(DATA_DIR, 'data.json'); // old single-file format

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(WEEKS_DIR)) fs.mkdirSync(WEEKS_DIR, { recursive: true });
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });

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
if (!fs.existsSync(META_FILE)) writeJSONAtomic(META_FILE, { user: null, shifts: [] });
function readMeta() { return readJSON(META_FILE, { user: null, shifts: [] }); }

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

// ── one-time migration from the old single data.json file, if present ──
(function migrateLegacyIfPresent() {
  if (!fs.existsSync(LEGACY_DATA_FILE)) return;
  try {
    const old = readJSON(LEGACY_DATA_FILE, null);
    if (!old) return;
    writeJSONAtomic(META_FILE, { user: old.user || null, shifts: old.shifts || [] });
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

app.use(express.json({ limit: '100mb' }));
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
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
    writeJSONAtomic(META_FILE, { user: body.user || null, shifts: body.shifts || [] });
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

// ── full merged snapshot — used ONLY on-demand for Summary/CSV/backup, never on boot ──
app.get('/api/all', (req, res) => {
  try {
    const meta = readMeta();
    const assignments = [];
    const dayNotes = {};
    fs.readdirSync(WEEKS_DIR).filter(f => f.endsWith('.json')).forEach(f => {
      const wd = readJSON(path.join(WEEKS_DIR, f), { assignments: [], dayNotes: {} });
      assignments.push(...(wd.assignments || []));
      Object.assign(dayNotes, wd.dayNotes || {});
    });
    res.json({ user: meta.user, shifts: meta.shifts, assignments, dayNotes });
  } catch (e) {
    console.error('Failed to read all data:', e);
    res.status(500).json({ error: 'Failed to read all data' });
  }
});

// ── restore from a full backup file — splits it back into meta + per-week slices ──
app.post('/api/restore', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || !Array.isArray(body.shifts)) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  try {
    writeJSONAtomic(META_FILE, { user: body.user || null, shifts: body.shifts || [] });
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
    res.json({ ok: true });
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

app.listen(PORT, () => {
  console.log(`Shifts app listening on port ${PORT}`);
});
