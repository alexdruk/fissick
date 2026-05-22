// src/processors/locationWorker.js
// Worker Thread — parses Google Takeout location history into the SQLite locations table.
// Handles two source formats:
//   Records.json        — array of raw GPS timestamped points (newer format)
//   Semantic Location History/  — monthly JSONs with named place visits (older format)
//
// Pattern matches photosWorker.js exactly: same send/status helpers, same DB open/close,
// same try/catch/finally structure, same batch-insert pattern.

'use strict';

const { workerData, parentPort } = require('worker_threads');
const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

function send(type, payload = {}) {
  parentPort.postMessage({ type, ...payload });
}
function status(phase, message) {
  send('status', { phase, message });
}

// SQLite batch size — 2000 rows per transaction balances write throughput vs memory
const BATCH_SIZE = 2000;

// ── Main pipeline ─────────────────────────────────────────────────────────────

async function run() {
  const { dbPath, recordsJson, semanticDir } = workerData;

  const db = new Database(dbPath);

  // Prepared insert — matches the CREATE TABLE in main.js initDb()
  const insertLoc = db.prepare(`
    INSERT INTO locations (lat, lng, accuracy, ts, type, name, address)
    VALUES (@lat, @lng, @accuracy, @ts, @type, @name, @address)
  `);
  const insertBatch = db.transaction(rows => {
    for (const r of rows) insertLoc.run(r);
  });

  let grandTotal = 0;

  try {

    // ── Phase 1: Records.json ─────────────────────────────────────────────────
    // The file can be 500 MB+ for heavy users. JSON.parse loads the whole thing
    // into this worker's heap. That's acceptable — the worker runs in a separate
    // V8 isolate, so the main process and renderer stay responsive throughout.
    // After parsing, we null the raw string and top-level object so V8's GC can
    // reclaim them before we start the insert loop.

    if (recordsJson) {
      const fileSizeMb = (fs.statSync(recordsJson).size / (1024 * 1024)).toFixed(1);
      status('location-parsing', `Reading Records.json (${fileSizeMb} MB)…`);

      let raw;
      try {
        raw = fs.readFileSync(recordsJson, 'utf8');
      } catch (e) {
        status('location-error', `Could not read Records.json: ${e.message}`);
        db.close();
        return;
      }

      status('location-parsing', 'Parsing JSON…');

      let locations;
      try {
        const parsed = JSON.parse(raw);
        raw = null; // release the 500 MB string before iterating
        locations = parsed.locations || [];
      } catch (e) {
        raw = null;
        status('location-error', `Records.json parse failed: ${e.message}`);
        db.close();
        return;
      }

      const total = locations.length;
      status('location-parsing', `Processing ${total.toLocaleString()} location points…`);

      let batch   = [];
      let processed = 0;

      for (const loc of locations) {
        // Guard: both coordinates must be integers (latitudeE7 / longitudeE7)
        if (typeof loc.latitudeE7 !== 'number' || typeof loc.longitudeE7 !== 'number') continue;

        const lat = loc.latitudeE7 / 1e7;
        const lng = loc.longitudeE7 / 1e7;

        // Skip null-island junk (0,0) — common in older exports
        if (Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001) continue;

        batch.push({
          lat,
          lng,
          accuracy: (typeof loc.accuracy === 'number') ? loc.accuracy : null,
          ts:       loc.timestamp ? new Date(loc.timestamp).getTime() : null,
          type:     'point',
          name:     null,
          address:  null,
        });

        if (batch.length >= BATCH_SIZE) {
          insertBatch(batch);
          grandTotal += batch.length;
          processed  += batch.length;
          batch = [];

          send('location-progress', {
            processed,
            total,
            percent: Math.round((processed / total) * 100),
          });
        }
      }

      // Final partial batch
      if (batch.length > 0) {
        insertBatch(batch);
        grandTotal += batch.length;
        processed  += batch.length;
      }

      send('location-progress', { processed, total, percent: 100 });
      status('location-parsing', `Inserted ${grandTotal.toLocaleString()} location points.`);
    }

    // ── Phase 2: Semantic Location History ────────────────────────────────────
    // Monthly JSON files, each containing a timelineObjects array.
    // We extract placeVisit entries — named places with start/end timestamps.
    // activitySegment entries (travel legs) are skipped for now (they only have
    // start/end coordinates, no place name, and overlap heavily with Records.json).

    if (semanticDir) {
      status('location-parsing', 'Parsing named place visits from Semantic Location History…');

      let files = [];
      try {
        files = fs.readdirSync(semanticDir)
          .filter(f => f.endsWith('.json'))
          .sort() // chronological order (2018_JANUARY.json … 2023_DECEMBER.json)
          .map(f => path.join(semanticDir, f));
      } catch (e) {
        // Semantic dir listed in manifest but unreadable — non-fatal, Records.json
        // data is already inserted
        status('location-error', `Cannot read Semantic Location History folder: ${e.message}`);
        files = [];
      }

      let visitsInserted = 0;

      for (const file of files) {
        let data;
        try {
          data = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
          continue; // malformed monthly file — skip silently
        }

        const objects = data.timelineObjects || [];
        const batch   = [];

        for (const obj of objects) {
          if (!obj.placeVisit) continue;

          const pv  = obj.placeVisit;
          const loc = pv.location;
          if (!loc || typeof loc.latitudeE7 !== 'number') continue;

          const lat = loc.latitudeE7 / 1e7;
          const lng = loc.longitudeE7 / 1e7;
          if (Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001) continue;

          // Use visit start time as the point's timestamp
          const startTs = pv.duration?.startTimestamp
            ? new Date(pv.duration.startTimestamp).getTime()
            : null;

          batch.push({
            lat,
            lng,
            accuracy: null,
            ts:      startTs,
            type:    'visit',
            name:    loc.name    || null,
            address: loc.address || null,
          });
        }

        if (batch.length > 0) {
          insertBatch(batch);
          visitsInserted += batch.length;
          grandTotal     += batch.length;
        }
      }

      if (visitsInserted > 0) {
        status('location-parsing', `Added ${visitsInserted.toLocaleString()} named place visits.`);
      }
    }

    // ── Phase 3: Final stats ──────────────────────────────────────────────────

    const stats = db.prepare(`
      SELECT
        COUNT(*)                                          AS total,
        MIN(ts)                                           AS earliest_ts,
        MAX(ts)                                           AS latest_ts,
        SUM(CASE WHEN type = 'visit' THEN 1 ELSE 0 END)  AS visits
      FROM locations
    `).get();

    send('location-summary', {
      total:      stats.total      || 0,
      visits:     stats.visits     || 0,
      earliestTs: stats.earliest_ts,
      latestTs:   stats.latest_ts,
    });

    status('location-done',
      `Location data ready — ${(stats.total || 0).toLocaleString()} points indexed.`
    );

  } catch (err) {
    console.error('[locationWorker] Fatal:', err);
    status('location-error', err.message);
  } finally {
    db.close();
    send('location-done', {}); // signals main.js to check if all workers are done
  }
}

run().catch(err =>
  parentPort.postMessage({ type: 'status', phase: 'location-error', message: err.message })
);
