// src/processors/photosWorker.js
// Worker Thread — runs the full photos processing pipeline off the main thread.
//
// Processing uses a concurrency pool rather than Promise.all batches.
// Promise.all batches stall when one slow file (e.g. a 4K video) blocks an
// entire batch while other CPU cores sit idle. The pool feeds the next file
// to ExifTool the instant any slot opens.

'use strict';

const { workerData, parentPort } = require('worker_threads');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const Database = require('better-sqlite3');

// sharp is optional — gracefully absent if not yet installed
let sharp = null;
try { sharp = require('sharp'); } catch {}

const { extractZips }       = require('./zipExtractor');
const { detectSchemas }     = require('./schemaDetector');
const {
  walkPhotosDirectory,
  walkForMediaOnly,
  buildJsonIndex,
  findSidecar,
  dateFromFilename,
  deduplicateMedia,
} = require('./sidecarMatcher');
const { writeExifFromSidecar, writeExifDate, shutdownExifTool } = require('./exifWriter');

function send(type, payload = {}) {
  parentPort.postMessage({ type, ...payload });
}
function status(phase, message) {
  send('status', { phase, message });
}

// Concurrency: half the CPUs, capped at 8, minimum 2
const CONCURRENCY = Math.min(8, Math.max(2, Math.floor(os.cpus().length / 2)));

// ── Concurrency pool ──────────────────────────────────────────────────────────
// Processes items from an array with a fixed number of concurrent workers.
// Unlike Promise.all batches, a new item starts the instant any slot finishes —
// no idle cores waiting for the slowest file in a batch.

async function withPool(items, concurrency, fn) {
  let index = 0;
  const results = new Array(items.length);

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

async function run() {
  const { zipPaths, extractedFolder, tempDir, dbPath, trialLimit, thumbDir } = workerData;
  const isLimited = trialLimit != null;
  if (isLimited) status('processing', `Trial mode: EXIF writing limited to first ${trialLimit} photos.`);

  const db = new Database(dbPath);

  const insertPhoto = db.prepare(`
    INSERT OR REPLACE INTO photos
      (file_path, filename, date_ts, lat, lng,
       exif_written, sidecar_found, date_source, exif_error, processed_at, thumbnail_path)
    VALUES
      (@filePath, @filename, @dateTs, @lat, @lng,
       @exifWritten, @sidecarFound, @dateSource, @exifError, @processedAt, @thumbnailPath)
  `);
  const insertBatch = db.transaction(rows => { for (const r of rows) insertPhoto.run(r); });

  try {

    // ── Phase 1: Extract ZIPs ───────────────────────────────────────────────
    let workDir = extractedFolder;

    if (zipPaths && zipPaths.length > 0) {
      const totalMb = zipPaths.reduce((s, p) => s + fs.statSync(p).size, 0) / (1024 * 1024);
      status('extracting', `Extracting ${zipPaths.length} ZIP (${totalMb.toFixed(1)} MB) to: ${tempDir}`);

      let extracted = 0;
      await extractZips(zipPaths, tempDir, ({ extracted: n }) => { extracted = n; });

      status('extracting', `Extracted ${extracted} files.`);

      if (extracted === 0) {
        status('error', 'ZIP extraction produced 0 files. Use "Select folder" and paste the path to an already-extracted Takeout folder instead.');
        db.close();
        return;
      }
      workDir = tempDir;
    }

    if (!workDir) {
      status('error', 'No source specified.');
      db.close();
      return;
    }

    // ── Phase 2: Detect schemas ─────────────────────────────────────────────
    status('scanning', `Scanning: ${workDir}`);
    const manifest = detectSchemas(workDir);
    send('manifest', { manifest });

    if (!manifest.photos) {
      status('scanning', 'No Google Photos folder found — scanning entire archive for media files.');
    }

    // ── Phase 3: Async walk + index ─────────────────────────────────────────
    // Strategy:
    //   A) Walk manifest.photos (Google Photos folder) for BOTH media + JSON sidecars.
    //      Sidecar matching only works within this structure — the JSONs live next to
    //      the media files they describe.
    //   B) Walk the entire workDir for any additional media files found outside Google
    //      Photos (Google Drive exports, Blogger media, etc.). These have no sidecars
    //      so they get filename-date extraction only.
    //   Deduplication by absolute path prevents double-counting files that appear in
    //   both walks (shouldn't happen in practice, but safe to guard).

    status('indexing', 'Indexing photos and sidecars…');

    let mediaFiles = [];
    let jsonFiles  = [];

    if (manifest.photos) {
      // Walk the Google Photos folder — both media and JSON sidecars
      const gp = await walkPhotosDirectory(manifest.photos);
      mediaFiles = gp.mediaFiles;
      jsonFiles  = gp.jsonFiles;
    }

    // Walk the entire workDir for any media outside Google Photos.
    // Pass an excludeDir so we don't re-walk Google Photos we already have.
    const extraMedia = await walkForMediaOnly(workDir, manifest.photos || null);
    mediaFiles = mediaFiles.concat(extraMedia);

    // Deduplicate by full path (covers the case where manifest.photos IS workDir)
    const seenPaths  = new Set();
    const allMedia   = mediaFiles.filter(p => {
      if (seenPaths.has(p)) return false;
      seenPaths.add(p);
      return true;
    });

    const uniqueMedia = deduplicateMedia(allMedia);
    const jsonIndex   = buildJsonIndex(jsonFiles);

    const outsideCount = extraMedia.length;

    send('counts', {
      totalMedia: uniqueMedia.length,
      totalJson:  jsonFiles.length,
      duplicates: allMedia.length - uniqueMedia.length,
      outsideGooglePhotos: outsideCount,
    });

    if (uniqueMedia.length === 0) {
      status('error', 'No image or video files found anywhere in the archive.');
      db.close();
      return;
    }

    if (outsideCount > 0) {
      status('indexing', `Found ${outsideCount.toLocaleString()} additional media file(s) outside Google Photos.`);
    }

    status('processing', `Processing ${uniqueMedia.length.toLocaleString()} photos with ${CONCURRENCY} concurrent ExifTool processes…`);

    // ── Phase 4: Concurrency-pool processing ────────────────────────────────
    let processed = 0, fixed = 0, matched = 0, failed = 0;
  let writesIssued = 0; // incremented synchronously before await — prevents race condition
  let trialLimitMessageSent = false;
  const startMs = Date.now();

    // Flush results to SQLite every N completions
    const FLUSH_EVERY = 50;
    let pendingRows = [];

    function flushPending() {
      if (pendingRows.length === 0) return;
      insertBatch(pendingRows);
      pendingRows = [];
    }

    function reportProgress() {
      const elapsed   = Date.now() - startMs;
      const rate      = processed / (elapsed / 1000);
      const remaining = uniqueMedia.length - processed;
      const etaSecs   = rate > 0 ? Math.round(remaining / rate) : null;
      send('progress', {
        processed, total: uniqueMedia.length,
        fixed, matched, failed,
        percent: Math.round((processed / uniqueMedia.length) * 100),
        etaSecs,
      });
    }

    await withPool(uniqueMedia, CONCURRENCY, async (mediaPath) => {
      const filename = path.basename(mediaPath);
      let dateTs = null, lat = null, lng = null;
      let exifWritten = 0, sidecarFound = 0;
      let dateSource = 'none', exifError = null;

      const sidecarPath = findSidecar(mediaPath, jsonIndex);

      if (sidecarPath) {
        sidecarFound = 1;

        let sidecarData;
        try {
          sidecarData = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
        } catch (e) {
          exifError = `Sidecar parse error: ${e.message}`;
          pendingRows.push(buildRow(mediaPath, filename, null, null, null, 0, 1, 'none', exifError));
          processed++;
          failed++;
          if (pendingRows.length >= FLUSH_EVERY) flushPending();
          reportProgress();
          return;
        }

        const rawTs = parseInt(sidecarData.photoTakenTime?.timestamp || 0, 10);
        if (rawTs > 0) { dateTs = rawTs * 1000; dateSource = 'sidecar'; }

        const geo = sidecarData.geoData || sidecarData.geoDataExif;
        if (geo && (Math.abs(geo.latitude) > 0.0001 || Math.abs(geo.longitude) > 0.0001)) {
          lat = geo.latitude;
          lng = geo.longitude;
        }

        // Trial limit — use writesIssued (incremented synchronously before await)
        // to prevent race condition where concurrent pool workers all see fixed < limit
        const underLimit = !isLimited || writesIssued < trialLimit;
        if (underLimit) writesIssued++; // claim the slot before awaiting

        if (underLimit) {
          const result = await writeExifFromSidecar(mediaPath, sidecarData, CONCURRENCY);
          if (result.written) {
            exifWritten = 1;
          } else {
            exifError = result.error;
            if (fixed + failed < 3) {
              send('status', { phase: 'processing', message: `⚠ EXIF failed: ${filename}: ${result.error}` });
            }
          }
        } else {
          exifError = 'trial_limit';
        }
      } else {
        const filenameDate = dateFromFilename(filename);
        if (filenameDate) {
          dateTs = filenameDate;
          dateSource = 'filename';
          const underLimit = !isLimited || writesIssued < trialLimit;
          if (underLimit) writesIssued++;
          if (underLimit) {
            const result = await writeExifDate(mediaPath, filenameDate, CONCURRENCY);
            if (result.written) exifWritten = 1;
            else exifError = result.error;
          } else {
            exifError = 'trial_limit';
          }
        }
      }

      const row = buildRow(mediaPath, filename, dateTs, lat, lng, exifWritten, sidecarFound, dateSource, exifError);

      // ── Thumbnail generation ────────────────────────────────────────────
      // HEIC/HEIF skipped — sharp can't decode them without libheif.
      // The "Generate Thumbnails" button uses nativeImage in the main process.
      if (sharp && thumbDir) {
        const ext = filename.split(".").pop()?.toLowerCase();
        const SHARP_EXTS = ["jpg","jpeg","png","gif","webp","bmp","tiff","tif","avif"];
        if (SHARP_EXTS.includes(ext)) {
          const safeBase = mediaPath.replace(/[/\\:]/g, "_").slice(-120);
          const thumbPath = path.join(thumbDir, safeBase + "_t.jpg");
          try {
            await sharp(mediaPath)
              .resize(280, 280, { fit: "inside", withoutEnlargement: true })
              .rotate()
              .jpeg({ quality: 72 })
              .toFile(thumbPath);
            row.thumbnailPath = thumbPath;
          } catch {}
        }
      }
      processed++;
      if (row.sidecarFound) matched++;
      if (row.exifWritten)  fixed++;
      if (!row.sidecarFound && row.dateSource === 'none') failed++;

      // Notify renderer exactly once when trial limit is hit
      if (isLimited && !trialLimitMessageSent && writesIssued >= trialLimit && !row.exifWritten && exifError === 'trial_limit') {
        trialLimitMessageSent = true;
        send('status', { phase: 'processing', message: `Trial limit reached: ${trialLimit} photos fixed. Remaining photos indexed but not written.` });
        send('trial-limit-hit', { limit: trialLimit });
      }

      pendingRows.push(row);
      if (pendingRows.length >= FLUSH_EVERY) flushPending();

      if (processed % FLUSH_EVERY === 0 || processed === uniqueMedia.length) {
        reportProgress();
      }
    });

    flushPending();

    // ── Phase 5: Done ───────────────────────────────────────────────────────
    await shutdownExifTool();

    status('done', `Done — fixed ${fixed.toLocaleString()} of ${uniqueMedia.length.toLocaleString()} photos.`);

    send('summary', { processed, fixed, matched, failed });

  } catch (err) {
    console.error('[photosWorker] Fatal error:', err);
    status('error', err.message);
  } finally {
    db.close();
    send('done', {});
  }
}

function buildRow(filePath, filename, dateTs, lat, lng, exifWritten, sidecarFound, dateSource, exifError) {
  return { filePath, filename, dateTs, lat, lng, exifWritten, sidecarFound, dateSource, exifError: exifError || null, processedAt: Date.now(), thumbnailPath: null };
}

run().catch(err => parentPort.postMessage({ type: 'status', phase: 'error', message: err.message }));
