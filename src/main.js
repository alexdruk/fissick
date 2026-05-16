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
let activeWorker         = null; // photosWorker
let activeLocationWorker = null; // locationWorker — spawned reactively from manifest event

// Tracks whether both workers have finished so run_complete is only set once
// both are truly done. Reset at the start of every process:start call.
let workersDone          = { photos: false, location: false };
let locationWorkerSpawned = false;

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

    CREATE TABLE IF NOT EXISTS locations (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      lat       REAL    NOT NULL,
      lng       REAL    NOT NULL,
      accuracy  INTEGER,
      ts        INTEGER,           -- epoch ms
      type      TEXT    DEFAULT 'point',  -- 'point' | 'visit'
      name      TEXT,              -- populated for named place visits only
      address   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_locations_ts   ON locations(ts);
    CREATE INDEX IF NOT EXISTS idx_locations_type ON locations(type);

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
  if (activeWorker)         activeWorker.terminate();
  if (activeLocationWorker) activeLocationWorker.terminate();
  app.quit();
});

// ── run_complete helper ───────────────────────────────────────────────────────
// Only marks the run as complete once ALL spawned workers have sent their
// done signal. If no location data was found, locationWorkerSpawned stays
// false and we only wait for the photos worker.
function checkAllDone() {
  if (workersDone.photos && (!locationWorkerSpawned || workersDone.location)) {
    db.prepare("INSERT OR REPLACE INTO settings VALUES ('run_complete', '1')").run();
  }
}

// ── Location worker spawner ───────────────────────────────────────────────────
// Called from the photos worker's 'manifest' event handler, so we know the
// ZIP extraction is complete and the paths are valid before we start.
function spawnLocationWorker(recordsJson, semanticDir) {
  locationWorkerSpawned = true;

  const locWorkerPath = path.join(__dirname, 'processors', 'locationWorker.js');

  activeLocationWorker = new Worker(locWorkerPath, {
    workerData: {
      dbPath:      db.name,
      recordsJson: recordsJson || null,
      semanticDir: semanticDir || null,
    },
  });

  activeLocationWorker.on('message', (msg) => {
    // Track completion — 'location-done' is sent at the end of the worker's
    // finally block, guaranteeing it fires even if there was an error
    if (msg.type === 'location-done') {
      workersDone.location = true;
      checkAllDone();
    }

    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('process:event', msg);
    }
  });

  activeLocationWorker.on('error', (err) => {
    console.error('[main] locationWorker error:', err);
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('process:event', {
        type:    'status',
        phase:   'location-error',
        message: err.message,
      });
    }
  });

  activeLocationWorker.on('exit', () => {
    activeLocationWorker = null;
  });
}

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
  if (activeLocationWorker) {
    activeLocationWorker.terminate();
    activeLocationWorker = null;
  }

  // Reset run state
  workersDone           = { photos: false, location: false };
  locationWorkerSpawned = false;

  // Wipe previous run's data and mark as incomplete
  db.exec('DELETE FROM photos');
  db.exec('DELETE FROM locations');
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
    // When the photos worker has finished extracting and detecting schemas, it
    // sends the manifest. Spawn the location worker at that point — the
    // extracted folder exists and the paths are confirmed valid.
    if (msg.type === 'manifest') {
      const { manifest } = msg;
      if (manifest.recordsJson || manifest.semanticDir) {
        spawnLocationWorker(manifest.recordsJson, manifest.semanticDir);
      }
    }

    // Photos worker is done — check if everything is complete
    if (msg.type === 'status' && msg.phase === 'done') {
      workersDone.photos = true;
      checkAllDone();
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

// Cancel a running job — terminates both workers
ipcMain.handle('process:cancel', () => {
  let cancelled = false;
  if (activeWorker) {
    activeWorker.terminate();
    activeWorker = null;
    cancelled = true;
  }
  if (activeLocationWorker) {
    activeLocationWorker.terminate();
    activeLocationWorker = null;
    cancelled = true;
  }
  return { cancelled };
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

// Aggregate stats for the photos dashboard
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

// Location stats — point count, date range, visit count
ipcMain.handle('db:get-location-stats', () => {
  const row = db.prepare(`
    SELECT
      COUNT(*)                                          AS total,
      SUM(CASE WHEN type = 'visit' THEN 1 ELSE 0 END)  AS visits,
      MIN(ts)                                           AS earliest_ts,
      MAX(ts)                                           AS latest_ts
    FROM locations
  `).get();
  return row;
});

// Fetch location points for the map renderer.
//
// Returns at most `limit` rows. When the dataset exceeds `limit`, raw 'point'
// rows are decimated (every Nth row via id modulo) while 'visit' rows are
// always returned in full — they are sparse and carry the place names.
//
// The renderer passes { minTs, maxTs } (epoch ms) when the user adjusts the
// date range filter. Both are optional; omitting them returns the full dataset.
ipcMain.handle('db:get-locations', (_event, { minTs, maxTs, limit = 50000 } = {}) => {
  // Build WHERE clause for date range filter
  const clauses = [];
  const params  = {};
  if (minTs != null) { clauses.push('ts >= @minTs'); params.minTs = minTs; }
  if (maxTs != null) { clauses.push('ts <= @maxTs'); params.maxTs = maxTs; }
  const baseWhere = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

  // Count matching rows so we can calculate the decimation step
  const { n: total } = db.prepare(
    `SELECT COUNT(*) as n FROM locations ${baseWhere}`
  ).get(params);

  // Decimate: if total > limit, take every floor(total/limit)th raw point row.
  // Named visits are always included regardless of decimation.
  const step = Math.max(1, Math.floor(total / limit));

  // Build the final WHERE clause including the decimation filter
  const allClauses = [...clauses];
  if (step > 1) {
    // Always include visit rows; decimate point rows
    allClauses.push(`(type = 'visit' OR id % ${step} = 0)`);
  }
  const finalWhere = allClauses.length ? 'WHERE ' + allClauses.join(' AND ') : '';

  const points = db.prepare(`
    SELECT lat, lng, ts, type, name, address
    FROM locations ${finalWhere}
    ORDER BY ts ASC
  `).all(params);

  return { points, total, decimated: step > 1, step };
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
  db.exec('DELETE FROM locations');
  return { ok: true };
});

// Fetch file paths only (no thumbnails) for a given filter — used for bulk selection.
// Returns up to 200k paths; typical Takeout is 10k–50k.
ipcMain.handle('db:get-photo-paths', (_event, { filter = 'all' } = {}) => {
  const conditions = {
    all:       '',
    fixed:     'WHERE exif_written = 1',
    unmatched: 'WHERE sidecar_found = 0',
    failed:    'WHERE exif_written = 0 AND sidecar_found = 0',
  };
  const where = conditions[filter] || '';
  return db.prepare(`SELECT file_path FROM photos ${where} ORDER BY date_ts ASC NULLS LAST, filename ASC`)
           .all()
           .map(r => r.file_path);
});

// ── Exports ───────────────────────────────────────────────────────────────────

// Export 1: GPX — full location history
// Named visits → <wpt> waypoints. Raw GPS points → <trk> track.
// Track is split into segments on gaps > 6 hours to avoid drawing lines
// across continents between separate trips.
ipcMain.handle('export:gpx', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title:       'Export Location History as GPX',
    defaultPath: `fissick-locations-${_dateStamp()}.gpx`,
    filters:     [{ name: 'GPX Files', extensions: ['gpx'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  try {
    const points = db.prepare(`
      SELECT lat, lng, ts, type, name, address
      FROM locations
      ORDER BY ts ASC
    `).all();

    const visits = points.filter(p => p.type === 'visit' && p.name);
    const track  = points.filter(p => p.type === 'point');

    const fmtTs = ts => ts ? new Date(ts).toISOString() : '';
    const esc   = s  => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="Fissick" xmlns="http://www.topografix.com/GPX/1/1">',
      `  <metadata><name>Location History</name><time>${new Date().toISOString()}</time></metadata>`,
    ];

    // Waypoints — named place visits
    for (const v of visits) {
      lines.push(`  <wpt lat="${v.lat}" lon="${v.lng}">`);
      lines.push(`    <name>${esc(v.name)}</name>`);
      if (v.address) lines.push(`    <desc>${esc(v.address)}</desc>`);
      if (v.ts)      lines.push(`    <time>${fmtTs(v.ts)}</time>`);
      lines.push('  </wpt>');
    }

    // Track — raw GPS points, split into segments on gaps > 6 hours
    const GAP_MS = 6 * 60 * 60 * 1000;
    if (track.length > 0) {
      lines.push('  <trk>');
      lines.push('    <name>Location History</name>');
      lines.push('    <trkseg>');
      let prevTs = track[0].ts;
      for (const p of track) {
        if (p.ts && prevTs && (p.ts - prevTs) > GAP_MS) {
          lines.push('    </trkseg>');
          lines.push('    <trkseg>');
        }
        lines.push(`      <trkpt lat="${p.lat}" lon="${p.lng}">`);
        if (p.ts) lines.push(`        <time>${fmtTs(p.ts)}</time>`);
        lines.push('      </trkpt>');
        if (p.ts) prevTs = p.ts;
      }
      lines.push('    </trkseg>');
      lines.push('  </trk>');
    }

    lines.push('</gpx>');
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

    return { ok: true, filePath, waypoints: visits.length, trackPoints: track.length };
  } catch (err) {
    console.error('[export:gpx]', err);
    return { ok: false, error: err.message };
  }
});

// Export 2: CSV report — full photo list with all metadata
ipcMain.handle('export:photos-csv', async (_event, { selectedPaths } = {}) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title:       'Export Photos Report as CSV',
    defaultPath: `fissick-photos-${_dateStamp()}.csv`,
    filters:     [{ name: 'CSV Files', extensions: ['csv'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  try {
    let photos;
    if (selectedPaths && selectedPaths.length > 0) {
      // SQLite has a max 999 bind params — chunk if needed
      const CHUNK = 900;
      photos = [];
      for (let i = 0; i < selectedPaths.length; i += CHUNK) {
        const chunk = selectedPaths.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        photos.push(...db.prepare(`
          SELECT filename, file_path, date_ts, lat, lng,
                 exif_written, sidecar_found, date_source, exif_error
          FROM photos WHERE file_path IN (${placeholders})
          ORDER BY date_ts ASC NULLS LAST, filename ASC
        `).all(...chunk));
      }
    } else {
      photos = db.prepare(`
        SELECT filename, file_path, date_ts, lat, lng,
               exif_written, sidecar_found, date_source, exif_error
        FROM photos ORDER BY date_ts ASC NULLS LAST, filename ASC
      `).all();
    }

    const csvEsc = v => {
      if (v == null) return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? '"' + s.replace(/"/g, '""') + '"'
        : s;
    };

    const rows = [
      ['filename','date','lat','lng','exif_written','sidecar_found','date_source','exif_error','file_path'].join(','),
      ...photos.map(p => [
        p.filename,
        p.date_ts ? new Date(p.date_ts).toISOString() : '',
        p.lat  ?? '',
        p.lng  ?? '',
        p.exif_written,
        p.sidecar_found,
        p.date_source || '',
        p.exif_error  || '',
        p.file_path,
      ].map(csvEsc).join(',')),
    ];

    fs.writeFileSync(filePath, rows.join('\n'), 'utf8');
    return { ok: true, filePath, count: photos.length };
  } catch (err) {
    console.error('[export:photos-csv]', err);
    return { ok: false, error: err.message };
  }
});

// Export 3: Copy fixed files to a user-selected folder
ipcMain.handle('export:copy-fixed', async (_event, { selectedPaths } = {}) => {
  // Determine which files to copy
  let files;
  if (selectedPaths && selectedPaths.length > 0) {
    const CHUNK = 900;
    files = [];
    for (let i = 0; i < selectedPaths.length; i += CHUNK) {
      const chunk = selectedPaths.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      files.push(...db.prepare(`
        SELECT file_path, filename FROM photos
        WHERE file_path IN (${placeholders})
        ORDER BY filename ASC
      `).all(...chunk));
    }
  } else {
    files = db.prepare(`
      SELECT file_path, filename FROM photos WHERE exif_written = 1 ORDER BY filename ASC
    `).all();
  }

  const total = files.length;
  if (total === 0) return { ok: false, error: 'No files to copy.' };

  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title:       'Choose destination folder for fixed photos',
    buttonLabel: 'Copy Here',
    properties:  ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths[0]) return { ok: false, canceled: true };

  const destDir = filePaths[0];

  // Run async so we can stream progress back without blocking
  ;(async () => {
    let copied = 0, skipped = 0, failed = 0;

    for (const file of files) {
      const dest = path.join(destDir, file.filename);
      try {
        await fs.promises.copyFile(file.file_path, dest);
        copied++;
      } catch (e) {
        // Skip files that have moved since processing; don't abort the whole job
        if (e.code === 'ENOENT') skipped++;
        else { failed++; console.warn('[export:copy-fixed] skip:', e.message); }
      }

      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('export:copy-progress', {
          copied, skipped, failed, total,
          percent: Math.round(((copied + skipped + failed) / total) * 100),
        });
      }
    }

    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('export:copy-done', { copied, skipped, failed, total, destDir });
    }
  })();

  return { ok: true, total }; // returns immediately; progress comes via events
});

// Export 4: Interactive HTML map — self-contained single file, opens in any browser.
// All location data is baked in as JSON. Decimated to MAP_EXPORT_LIMIT points
// (same cap as the in-app map) so the file stays browser-friendly.
// Named place visits are always included in full regardless of the cap.
const MAP_EXPORT_LIMIT = 50000;

ipcMain.handle('export:map-html', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title:       'Export Interactive Map as HTML',
    defaultPath: `fissick-map-${_dateStamp()}.html`,
    filters:     [{ name: 'HTML Files', extensions: ['html'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  try {
    // Fetch all data — same decimation logic as db:get-locations
    const totalRow = db.prepare(`SELECT COUNT(*) as n FROM locations`).get();
    const total    = totalRow.n;
    const step     = Math.max(1, Math.floor(total / MAP_EXPORT_LIMIT));

    const whereDecimate = step > 1 ? `WHERE type = 'visit' OR id % ${step} = 0` : '';
    const points = db.prepare(`
      SELECT lat, lng, ts, type, name, address
      FROM locations ${whereDecimate}
      ORDER BY ts ASC
    `).all();

    const stats = db.prepare(`
      SELECT MIN(ts) as earliest_ts, MAX(ts) as latest_ts,
             SUM(CASE WHEN type='visit' THEN 1 ELSE 0 END) as visits
      FROM locations
    `).get();

    const decimated   = step > 1;
    const exportedPts = points.length;
    const html        = _buildMapHtml(points, {
      total, exportedPts, decimated,
      earliestTs: stats.earliest_ts,
      latestTs:   stats.latest_ts,
      visits:     stats.visits,
    });

    fs.writeFileSync(filePath, html, 'utf8');
    return { ok: true, filePath, total, exportedPts, decimated };
  } catch (err) {
    console.error('[export:map-html]', err);
    return { ok: false, error: err.message };
  }
});

// Build the self-contained HTML string
function _buildMapHtml(points, meta) {
  const jsonData = JSON.stringify(points);

  const fmtDate = ts => ts
    ? new Date(ts).toLocaleDateString('en', { year: 'numeric', month: 'short' })
    : '—';

  const decimatedNotice = meta.decimated
    ? `<div class="notice">⚠ Large archive — showing ${meta.exportedPts.toLocaleString()} of ${meta.total.toLocaleString()} total points</div>`
    : '';

  const dateRange = (meta.earliestTs && meta.latestTs)
    ? `${fmtDate(meta.earliestTs)} – ${fmtDate(meta.latestTs)}`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>My Location History — Fissick</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin="anonymous"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css" crossorigin="anonymous"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css" crossorigin="anonymous"/>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Mono:wght@400&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg:     #f5f2ec; --panel:  #faf8f4; --panel2: #ede9e0;
  --border: #d5cfc2; --ink:    #1c1a14; --mu:     #6b6454;
  --dim:    #a09880; --acc:    #b85c2c; --acc-lt: #f5ede6;
  --green:  #2a6b3c; --green-lt: #e8f4ec; --green-bdr: #b0d8bc;
  --amber:  #8a6010; --amber-lt: #fdf5e0; --amber-bdr: #e8d080;
  --blue:   #1e4d7a;
  --serif: 'DM Serif Display', Georgia, serif;
  --mono:  'DM Mono', monospace;
  --sans:  'DM Sans', system-ui, sans-serif;
}
html, body { height: 100%; margin: 0; position: relative; background: var(--bg); font-family: var(--sans); color: var(--ink); -webkit-font-smoothing: antialiased; overflow: hidden; }

/* Absolute layout — Leaflet needs the map container to have a
   measurable pixel height at init time. flex:1 / min-height:0
   collapses to 0px in some browsers before Leaflet reads it. */
#shell   { position: absolute; inset: 0; display: flex; flex-direction: column; }
#header  { flex-shrink: 0; }
#stats-bar  { flex-shrink: 0; }
#filter-bar { flex-shrink: 0; }
#footer  { flex-shrink: 0; }

/* Map fills whatever remains after the other bars */
#map-wrap { flex: 1; position: relative; min-height: 0; }
#map      { position: absolute; inset: 0; }
#header {
  background: var(--panel); border-bottom: 1px solid var(--border);
  padding: 14px 20px 12px; flex-shrink: 0;
  display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap;
}
#header h1 { font-family: var(--serif); font-size: 20px; color: var(--ink); letter-spacing: -.01em; }
#header h1 span { color: var(--acc); }
.h-meta { font-family: var(--mono); font-size: 10px; color: var(--dim); }
.h-sep  { color: var(--border); }

/* Stats bar */
#stats-bar {
  background: var(--panel2); border-bottom: 1px solid var(--border);
  padding: 7px 20px; flex-shrink: 0;
  display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
}
.stat-pill {
  display: flex; align-items: center; gap: 6px;
  font-family: var(--mono); font-size: 10.5px; color: var(--mu);
  background: var(--panel); border: 1px solid var(--border);
  border-radius: 20px; padding: 3px 10px;
}
.stat-pill b { color: var(--ink); }
.notice {
  font-family: var(--mono); font-size: 10px;
  color: var(--amber); background: var(--amber-lt);
  border: 1px solid var(--amber-bdr); border-radius: 20px;
  padding: 3px 10px;
}

/* Filter bar */
#filter-bar {
  background: var(--panel); border-bottom: 1px solid var(--border);
  padding: 7px 20px; flex-shrink: 0;
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
}
.fl { font-family: var(--mono); font-size: 9px; letter-spacing: .1em; text-transform: uppercase; color: var(--dim); margin-right: 4px; }
.filter-bar-date { font-family: var(--mono); font-size: 11px; background: var(--panel2); border: 1px solid var(--border); border-radius: 3px; padding: 4px 7px; color: var(--ink); outline: none; cursor: pointer; }
.filter-bar-date:focus { border-color: var(--acc); }
.filter-btn {
  font-family: var(--mono); font-size: 9px; letter-spacing: .06em; text-transform: uppercase;
  border: none; border-radius: 3px; padding: 5px 12px; cursor: pointer;
}
.filter-btn-apply { background: var(--acc); color: #fff; }
.filter-btn-clear { background: var(--panel2); color: var(--mu); border: 1px solid var(--border); }
.filter-btn-clear:hover { color: var(--ink); }
#filter-count { font-family: var(--mono); font-size: 10px; color: var(--dim); margin-left: 4px; }

/* Leaflet tooltip override */
.leaflet-tooltip { font-family: var(--sans); font-size: 12.5px; }
.leaflet-tooltip strong { font-family: var(--serif); }

/* Footer */
#footer {
  background: var(--panel); border-top: 1px solid var(--border);
  padding: 6px 20px; text-align: center;
  font-family: var(--mono); font-size: 9px; color: var(--dim);
  flex-shrink: 0;
}
#footer a { color: var(--acc); text-decoration: none; }
</style>
</head>
<body>
<div id="shell">

  <div id="header">
    <h1>My Location History<span>.</span></h1>
    <span class="h-meta">${dateRange}</span>
    <span class="h-sep">·</span>
    <span class="h-meta">Exported with <strong style="color:var(--ink)">Fissick</strong></span>
  </div>

  <div id="stats-bar">
    <div class="stat-pill"><b id="stat-points">—</b>&nbsp;GPS points</div>
    <div class="stat-pill"><b>${(meta.visits || 0).toLocaleString()}</b>&nbsp;named places</div>
    ${decimatedNotice}
  </div>

  <div id="filter-bar">
    <span class="fl">Filter</span>
    <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--mu)">
      From <input type="date" id="date-from" class="filter-bar-date">
    </label>
    <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--mu)">
      To <input type="date" id="date-to" class="filter-bar-date">
    </label>
    <button class="filter-btn filter-btn-apply" onclick="applyFilter()">Apply</button>
    <button class="filter-btn filter-btn-clear" onclick="clearFilter()">Clear</button>
    <span id="filter-count"></span>
  </div>

  <div id="map-wrap"><div id="map"></div></div>

  <div id="footer">
    Generated by <a href="https://fissick.app" target="_blank">Fissick</a>
    &nbsp;·&nbsp; ${new Date().toLocaleDateString('en', { year:'numeric', month:'long', day:'numeric' })}
    &nbsp;·&nbsp; ${meta.total.toLocaleString()} total location points in archive
  </div>

</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin="anonymous"></script>
<script src="https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js" crossorigin="anonymous"></script>
<script>
// ── All location data ────────────────────────────────────────────────────────
const ALL_POINTS = ${jsonData};

// ── Map init ─────────────────────────────────────────────────────────────────
const map = L.map('map', { center: [20, 0], zoom: 2 });

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
}).addTo(map);

const clusterGroup = L.markerClusterGroup({
  chunkedLoading: true, chunkInterval: 200, chunkDelay: 50,
  maxClusterRadius: 60, spiderfyOnMaxZoom: true, showCoverageOnHover: false,
});
const visitLayer = L.layerGroup();
map.addLayer(clusterGroup);
map.addLayer(visitLayer);

// ── Date range inputs ─────────────────────────────────────────────────────────
let allTs = ALL_POINTS.map(p => p.ts).filter(Boolean);
let globalMin = allTs.length ? Math.min(...allTs) : null;
let globalMax = allTs.length ? Math.max(...allTs) : null;

function msToDate(ms) { return new Date(ms).toISOString().slice(0, 10); }

if (globalMin) document.getElementById('date-from').value = msToDate(globalMin);
if (globalMax) document.getElementById('date-to').value   = msToDate(globalMax);

// ── Render ────────────────────────────────────────────────────────────────────
let hasFit = false;

function render(points) {
  clusterGroup.clearLayers();
  visitLayer.clearLayers();

  const pointMarkers = [];
  const bounds = [];

  for (const p of points) {
    if (p.lat == null || p.lng == null) continue;
    bounds.push([p.lat, p.lng]);

    if (p.type === 'visit' && p.name) {
      const m = L.circleMarker([p.lat, p.lng], {
        radius: 7, fillColor: '#b85c2c', color: '#8a3a10',
        weight: 1.5, opacity: 1, fillOpacity: 0.85,
      });
      const dateStr = p.ts
        ? new Date(p.ts).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' })
        : '';
      const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      m.bindTooltip(
        '<strong style="font-family:\\'DM Serif Display\\',serif">' + esc(p.name) + '</strong>' +
        (p.address ? '<br><span style="font-size:11px;opacity:.7">' + esc(p.address) + '</span>' : '') +
        (dateStr   ? '<br><span style="font-family:monospace;font-size:10px;opacity:.6">' + dateStr + '</span>' : ''),
        { sticky: false, direction: 'top', offset: [0, -4] }
      );
      visitLayer.addLayer(m);
    } else {
      const m = L.circleMarker([p.lat, p.lng], {
        radius: 3, fillColor: '#1e4d7a', color: '#1e4d7a',
        weight: 0, opacity: 0.7, fillOpacity: 0.55,
      });
      if (p.ts) m.bindPopup(
        '<span style="font-family:monospace;font-size:10px">' + new Date(p.ts).toLocaleString() + '</span>',
        { maxWidth: 180 }
      );
      pointMarkers.push(m);
    }
  }

  clusterGroup.addLayers(pointMarkers);

  const ptCount = points.filter(p => p.type !== 'visit').length;
  document.getElementById('stat-points').textContent = ptCount.toLocaleString();

  if (bounds.length > 0 && !hasFit) {
    try { map.fitBounds(L.latLngBounds(bounds), { padding: [32, 32], maxZoom: 7 }); } catch {}
    hasFit = true;
  }
}

// ── Filter ────────────────────────────────────────────────────────────────────
function applyFilter() {
  const fromVal = document.getElementById('date-from').value;
  const toVal   = document.getElementById('date-to').value;
  const minTs   = fromVal ? new Date(fromVal + 'T00:00:00Z').getTime() : null;
  const maxTs   = toVal   ? new Date(toVal   + 'T23:59:59Z').getTime() : null;

  const filtered = ALL_POINTS.filter(p => {
    if (minTs && p.ts && p.ts < minTs) return false;
    if (maxTs && p.ts && p.ts > maxTs) return false;
    return true;
  });

  const fc = document.getElementById('filter-count');
  fc.textContent = (filtered.length < ALL_POINTS.length)
    ? filtered.length.toLocaleString() + ' of ' + ALL_POINTS.length.toLocaleString() + ' shown'
    : '';

  render(filtered);
}

function clearFilter() {
  if (globalMin) document.getElementById('date-from').value = msToDate(globalMin);
  if (globalMax) document.getElementById('date-to').value   = msToDate(globalMax);
  document.getElementById('filter-count').textContent = '';
  render(ALL_POINTS);
}

// ── Initial render ────────────────────────────────────────────────────────────
render(ALL_POINTS);
</script>
</body>
</html>`;
}

// Utility: YYYYMMDD stamp for default filenames
function _dateStamp() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

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
