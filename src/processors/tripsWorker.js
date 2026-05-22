// src/processors/tripsWorker.js
// Trip detection from confirmed home zones.
// Uses calendar-day gap rule: 2 consecutive days with no photos = split.
// Input: photos.lat/lng/date_ts (or locations table if Timeline data exists).

'use strict';
const { workerData, parentPort } = require('worker_threads');
const Database = require('better-sqlite3');

const { dbPath, homeZones } = workerData;

const HOME_RADIUS_KM = 50;    // must be >50km from ALL home zones to be "away"
const MAX_SPEED_KMH  = 500;   // GPS outlier filter
const GAP_DAYS       = 2;     // 2 consecutive calendar days with no photos = split

function post(msg) { parentPort.postMessage(msg); }

// ── Haversine distance (km) ──────────────────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R  = 6371;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const a  = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function isHome(lat, lng) {
  for (const z of homeZones)
    if (haversine(lat, lng, z.lat, z.lng) <= HOME_RADIUS_KM) return true;
  return false;
}

// Return UTC date string YYYY-MM-DD from epoch ms
function toDateStr(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

// Number of calendar days between two YYYY-MM-DD strings.
// Explicit UTC parsing — new Date('YYYY-MM-DD') is treated as UTC by spec
// but behaviour across runtimes/timezones has historically been inconsistent.
// Splitting and using Date.UTC is unambiguous.
function parseDateStrUTC(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
function calDayGap(dateA, dateB) {
  return Math.round((parseDateStrUTC(dateB) - parseDateStrUTC(dateA)) / 86400000);
}

function fallbackName(ts) {
  return 'Trip ' + new Date(ts).toLocaleDateString('en', { month: 'short', year: 'numeric' });
}

function run() {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  post({ type: 'trips-status', phase: 'loading', message: 'Loading location history…' });

  // Decide data source
  const { n: locCount } = db.prepare(
    `SELECT COUNT(*) AS n FROM locations WHERE ts IS NOT NULL AND lat IS NOT NULL`
  ).get();
  const usePhotos = locCount === 0;

  const countQuery = usePhotos
    ? `SELECT COUNT(*) AS n FROM photos WHERE date_ts IS NOT NULL AND lat IS NOT NULL AND lng IS NOT NULL`
    : `SELECT COUNT(*) AS n FROM locations WHERE ts IS NOT NULL AND lat IS NOT NULL AND lng IS NOT NULL`;

  const { n: total } = db.prepare(countQuery).get();

  if (total === 0) {
    post({ type: 'trips-done', count: 0, needsGeocode: [] });
    db.close();
    return;
  }

  const sourceLabel = usePhotos ? 'photo GPS' : 'location history';
  post({ type: 'trips-status', phase: 'classifying',
         message: `Classifying ${total.toLocaleString()} ${sourceLabel} points…` });

  const stmt = usePhotos
    ? db.prepare(`SELECT lat, lng, date_ts AS ts FROM photos
                  WHERE date_ts IS NOT NULL AND lat IS NOT NULL AND lng IS NOT NULL
                  ORDER BY date_ts ASC`)
    : db.prepare(`SELECT lat, lng, ts FROM locations
                  WHERE ts IS NOT NULL AND lat IS NOT NULL AND lng IS NOT NULL
                  ORDER BY ts ASC`);

  // seg tracks: startTs, endTs, latSum, lngSum, count, lastDate (YYYY-MM-DD)
  let seg = null;
  let prevLat = null, prevLng = null, prevTs = null;
  const segments = [];
  let done = 0;
  const progressInterval = Math.max(500, Math.floor(total / 20));

  for (const p of stmt.iterate()) {
    done++;

    // Outlier filter
    if (prevLat !== null && prevTs !== null) {
      const timeDiffH = (p.ts - prevTs) / 3_600_000;
      if (timeDiffH > 0 && timeDiffH < 2) {
        const dist = haversine(prevLat, prevLng, p.lat, p.lng);
        if (dist / timeDiffH > MAX_SPEED_KMH) continue;
      }
    }

    prevLat = p.lat;
    prevLng = p.lng;
    prevTs  = p.ts;

    const home = isHome(p.lat, p.lng);

    if (home) {
      if (seg) { segments.push(seg); seg = null; }
    } else {
      const currentDate = toDateStr(p.ts);
      if (!seg) {
        seg = { startTs: p.ts, endTs: p.ts, lastDate: currentDate,
                latSum: p.lat, lngSum: p.lng, count: 1 };
      } else if (calDayGap(seg.lastDate, currentDate) >= GAP_DAYS) {
        // 2+ calendar days without any photo = split trip
        segments.push(seg);
        seg = { startTs: p.ts, endTs: p.ts, lastDate: currentDate,
                latSum: p.lat, lngSum: p.lng, count: 1 };
      } else {
        seg.endTs    = p.ts;
        seg.lastDate = currentDate;
        seg.latSum  += p.lat;
        seg.lngSum  += p.lng;
        seg.count++;
      }
    }

    if (done % progressInterval === 0) {
      post({ type: 'trips-progress', done, total,
             message: `${done.toLocaleString()} / ${total.toLocaleString()} points…` });
    }
  }
  if (seg) segments.push(seg);

  // Minimum: at least 1 away point (implicit) and centroid >50km from home (already guaranteed)
  const qualifying = segments.filter(s => s.count >= 1);

  post({ type: 'trips-status', phase: 'writing',
         message: `${qualifying.length} trips found. Writing to database…` });

  db.prepare('UPDATE photos SET trip_id = NULL').run();
  db.exec('DELETE FROM trips');

  const insertTrip = db.prepare(`
    INSERT INTO trips (name, start_ts, end_ts, center_lat, center_lng, photo_count, point_count)
    VALUES (@name, @start_ts, @end_ts, @center_lat, @center_lng, @photo_count, @point_count)
  `);

  const assignPhotos = db.prepare(
    `UPDATE photos SET trip_id = ? WHERE date_ts >= ? AND date_ts <= ?`
  );

  const needsGeocode = [];

  const writeAll = db.transaction(() => {
    for (const s of qualifying) {
      const centerLat = s.latSum / s.count;
      const centerLng = s.lngSum / s.count;

      const visitRow = usePhotos ? null : db.prepare(`
        SELECT name, COUNT(*) AS cnt FROM locations
        WHERE type = 'visit' AND ts >= ? AND ts <= ? AND name IS NOT NULL
        GROUP BY name ORDER BY cnt DESC LIMIT 1
      `).get(s.startTs, s.endTs);

      const { n: photoCount } = db.prepare(
        `SELECT COUNT(*) AS n FROM photos WHERE date_ts >= ? AND date_ts <= ?`
      ).get(s.startTs, s.endTs);

      const name = visitRow?.name || fallbackName(s.startTs);

      const { lastInsertRowid: tripId } = insertTrip.run({
        name,
        start_ts:    s.startTs,
        end_ts:      s.endTs,
        center_lat:  centerLat,
        center_lng:  centerLng,
        photo_count: photoCount || 0,
        point_count: s.count,
      });

      assignPhotos.run(tripId, s.startTs, s.endTs);

      if (!visitRow?.name) {
        needsGeocode.push({ tripId, lat: centerLat, lng: centerLng });
      }
    }
  });

  writeAll();
  post({ type: 'trips-done', count: qualifying.length, needsGeocode });
  db.close();
}

try {
  run();
} catch (err) {
  post({ type: 'trips-error', message: err.message, stack: err.stack });
}
