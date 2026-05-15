// src/main.js — Electron main process
// Handles: window creation, IPC, SQLite init, local-file protocol, Worker lifecycle

const { app, BrowserWindow, ipcMain, dialog, protocol, shell } = require('electron');
const path = require('path');
const { Worker } = require('worker_threads');
const Database = require('better-sqlite3');
const os = require('os');
const fs = require('fs');

let mainWindow;
let db;
let activeWorker = null;

// ── Protocol registration must happen before app.whenReady ───────────────────
// Allows renderer to display local images via  local:///absolute/path/to/file.jpg
app.on('ready', () => {
  protocol.registerFileProtocol('local', (request, callback) => {
    // Strip the protocol prefix and decode URI components (spaces, unicode, etc.)
    const filePath = decodeURIComponent(request.url.replace('local://', ''));
    callback({ path: filePath });
  });
});

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#f5f2ec',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Allow loading local: protocol images
      allowRunningInsecureContent: false,
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    show: false,
    title: 'Fissick',
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Open external links in the system browser, not Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ── Database init ─────────────────────────────────────────────────────────────
function initDb() {
  const dbPath = path.join(app.getPath('userData'), 'fissick.db');
  db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS photos (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path        TEXT    NOT NULL UNIQUE,
      filename         TEXT    NOT NULL,
      date_ts          INTEGER,           -- epoch ms
      lat              REAL,
      lng              REAL,
      exif_written     INTEGER DEFAULT 0, -- 1 = successfully wrote EXIF
      sidecar_found    INTEGER DEFAULT 0, -- 1 = matched to a JSON sidecar
      date_source      TEXT,              -- 'sidecar' | 'filename' | 'none'
      exif_error       TEXT,              -- error message if EXIF write failed
      processed_at     INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_photos_date    ON photos(date_ts);
    CREATE INDEX IF NOT EXISTS idx_photos_exif    ON photos(exif_written);
    CREATE INDEX IF NOT EXISTS idx_photos_sidecar ON photos(sidecar_found);
    CREATE INDEX IF NOT EXISTS idx_photos_lat     ON photos(lat) WHERE lat IS NOT NULL;

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  return db;
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  initDb();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (db) db.close();
  if (activeWorker) activeWorker.terminate();
  app.quit();
});

// ── IPC Handlers ──────────────────────────────────────────────────────────────

// File selection dialogs
ipcMain.handle('dialog:select-zips', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Google Takeout ZIP files',
    message: 'Select one or more Takeout ZIP files (e.g. takeout-20230815-001.zip)',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'ZIP Archives', extensions: ['zip'] }],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('dialog:select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select your Takeout folder',
    message: 'Select the folder that contains "Google Photos" — usually named "Takeout" or "fake-takeout"',
    buttonLabel: 'Select This Folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  console.log('[main] dialog:select-folder result:', result);
  return result.canceled ? null : result.filePaths[0];
});

// Start processing — spawns Worker Thread, forwards events to renderer
ipcMain.handle('process:start', (_event, { zipPaths, extractedFolder }) => {
  if (activeWorker) {
    activeWorker.terminate();
    activeWorker = null;
  }

  // Wipe previous run's data and mark as incomplete
  db.exec('DELETE FROM photos');
  db.prepare("INSERT OR REPLACE INTO settings VALUES ('run_complete', '0')").run();

  const workerPath = path.join(__dirname, 'processors', 'photosWorker.js');

  // Determine extraction destination:
  // - If user specified a folder alongside ZIPs → extract there (their intent)
  // - If ZIPs only → extract to ~/Documents/fissick-extracted so user can see files
  // - If folder only (pre-extracted) → use it directly, no extraction needed
  let extractTo = null;
  if (zipPaths && zipPaths.length > 0) {
    if (extractedFolder) {
      extractTo = extractedFolder; // user designated this as the destination
    } else {
      const docsDir = app.getPath('documents');
      // Clean up previous auto-extraction folders
      try {
        const entries = fs.readdirSync(docsDir);
        for (const e of entries) {
          if (e.startsWith('fissick-extracted-')) {
            fs.rmSync(path.join(docsDir, e), { recursive: true, force: true });
          }
        }
      } catch {}
      extractTo = path.join(docsDir, 'fissick-extracted-' + Date.now());
    }
    fs.mkdirSync(extractTo, { recursive: true });
  }

  // Licence check — get trial limit before spawning worker
  const licenceRow = db.prepare("SELECT value FROM settings WHERE key = 'licence_key'").get();
  const licensed   = !!licenceRow?.value;

  activeWorker = new Worker(workerPath, {
    workerData: {
      zipPaths:        zipPaths || [],
      extractedFolder: zipPaths && zipPaths.length > 0 ? null : (extractedFolder || null),
      tempDir:         extractTo || '',
      dbPath:          db.name,
      trialLimit:      licensed ? null : 100,  // null = unlimited
    },
  });

  activeWorker.on('message', (msg) => {
    // Mark run as complete when the worker signals done
    if (msg.type === 'status' && msg.phase === 'done') {
      db.prepare("INSERT OR REPLACE INTO settings VALUES ('run_complete', '1')").run();
    }
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('process:event', msg);
    }
  });

  activeWorker.on('error', (err) => {
    console.error('Worker error:', err);
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('process:event', {
        type: 'status',
        phase: 'error',
        message: err.message,
      });
    }
  });

  activeWorker.on('exit', (code) => {
    activeWorker = null;
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('process:event', { type: 'done', code });
    }
    // Note: we no longer delete the extracted folder — user may want to inspect it
  });

  return { started: true };
});

// Cancel a running job
ipcMain.handle('process:cancel', () => {
  if (activeWorker) {
    activeWorker.terminate();
    activeWorker = null;
    return { cancelled: true };
  }
  return { cancelled: false };
});

// Query photos with pagination and filtering
ipcMain.handle('db:get-photos', (_event, { offset = 0, limit = 60, filter = 'all' } = {}) => {
  const conditions = {
    all:       '',
    matched:   'WHERE sidecar_found = 1',
    unmatched: 'WHERE sidecar_found = 0',
    fixed:     'WHERE exif_written = 1',
    failed:    'WHERE exif_written = 0 AND sidecar_found = 0',
  };

  const where = conditions[filter] || '';

  const photos = db.prepare(`
    SELECT * FROM photos ${where}
    ORDER BY date_ts ASC NULLS LAST, filename ASC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  const total = db.prepare(`SELECT COUNT(*) as n FROM photos ${where}`).get().n;

  return { photos, total };
});

// Aggregate stats for the dashboard
ipcMain.handle('db:get-stats', () => {
  const row = db.prepare(`
    SELECT
      COUNT(*)                                                        AS total,
      SUM(exif_written)                                              AS fixed,
      SUM(sidecar_found)                                             AS matched,
      SUM(CASE WHEN sidecar_found = 0 THEN 1 ELSE 0 END)            AS unmatched,
      SUM(CASE WHEN lat IS NOT NULL THEN 1 ELSE 0 END)              AS with_gps,
      MIN(date_ts)                                                   AS earliest_ts,
      MAX(date_ts)                                                   AS latest_ts,
      SUM(CASE WHEN exif_error = 'trial_limit' THEN 1 ELSE 0 END)   AS trial_limited
    FROM photos
  `).get();
  return row;
});

// Only show results on startup if the last run completed (not Ctrl+C interrupted)
ipcMain.handle('db:has-data', () => {
  const photos = db.prepare('SELECT COUNT(*) as n FROM photos').get();
  if (photos.n === 0) return false;
  const flag = db.prepare("SELECT value FROM settings WHERE key = 'run_complete'").get();
  return flag?.value === '1';
});

// Reset all data (for re-processing)
ipcMain.handle('db:reset', () => {
  db.exec('DELETE FROM photos');
  return { ok: true };
});

// ── Licence ───────────────────────────────────────────────────────────────────
const TRIAL_LIMIT = 100;

ipcMain.handle('licence:get-status', () => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'licence_key'").get();
  const key = row?.value || null;
  return { licensed: !!key, key, trialLimit: TRIAL_LIMIT };
});

ipcMain.handle('licence:activate', async (_event, { key }) => {
  if (!key || typeof key !== 'string') return { ok: false, error: 'No key provided' };
  const clean = key.trim().toUpperCase();

  // Validate against Gumroad licence API
  try {
    const res = await fetch('https://api.gumroad.com/v2/licenses/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        product_id:   'fissick',   // replace with real Gumroad product permalink
        license_key:  clean,
        increment_uses_count: 'false',
      }),
    });
    const data = await res.json();

    if (data.success) {
      db.prepare("INSERT OR REPLACE INTO settings VALUES ('licence_key', ?)").run(clean);
      return { ok: true };
    } else {
      return { ok: false, error: data.message || 'Invalid licence key' };
    }
  } catch (err) {
    // Network unavailable — accept the key offline (user can't fake a key format)
    // In production, add format validation here (e.g. Gumroad keys are UUID format)
    console.warn('[licence] Gumroad unreachable, accepting offline:', clean);
    db.prepare("INSERT OR REPLACE INTO settings VALUES ('licence_key', ?)").run(clean);
    return { ok: true, offline: true };
  }
});

ipcMain.handle('licence:deactivate', () => {
  db.prepare("DELETE FROM settings WHERE key = 'licence_key'").run();
  return { ok: true };
});

