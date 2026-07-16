const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify({ user: null, shifts: [], assignments: [], dayNotes: {} }, null, 2)
  );
}

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Read the whole shared schedule
app.get('/api/data', (req, res) => {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    res.json(JSON.parse(raw));
  } catch (e) {
    console.error('Failed to read data file:', e);
    res.status(500).json({ error: 'Failed to read data' });
  }
});

// Overwrite the whole shared schedule (the front-end always sends the full state)
app.put('/api/data', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  try {
    // Write to a temp file then rename, so a crash mid-write can't corrupt the data file
    const tmpFile = DATA_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(body, null, 2));
    fs.renameSync(tmpFile, DATA_FILE);
    res.json({ ok: true });
  } catch (e) {
    console.error('Failed to write data file:', e);
    res.status(500).json({ error: 'Failed to save data' });
  }
});

// Save an extra real image-file copy of a photo into data/photos/.
// This is purely a convenience copy on disk — the app itself keeps working
// from the photo embedded in data.json regardless of whether this succeeds.
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

app.listen(PORT, () => {
  console.log(`Shifts app listening on port ${PORT}`);
});
