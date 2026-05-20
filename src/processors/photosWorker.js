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

// ffmpeg for HEIC/video thumbnails — bundled via ffmpeg-static, no system install needed
const { execFile }   = require('child_process');
const { promisify }  = require('util');
const execFileAsync  = promisify(execFile);
const FFMPEG_BIN     = require('ffmpeg-static');

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
  console.log(`[fossick] ${phase}: ${message}`);
  send('status', { phase, message });
}

// Concurrency: half the CPUs, capped at 8, minimum 2
// Outer pool depth: 2× CPU count keeps all ExifTool processes fed with work.
// ExifTool is I/O-bound so this causes no meaningful CPU pressure.
const CONCURRENCY = Math.max(8, os.cpus().length * 2);

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
  const { zipPaths, extractedFolder, tempDir, dbPath, trialLimit, thumbDir, controlSab } = workerData;
  const isLimited = trialLimit != null;
  if (isLimited) status('processing', `Trial mode: EXIF writing limited to first ${trialLimit} photos.`);

  // Control byte: 0=run, 1=paused, 2=abort
  const ctrl = controlSab ? new Int8Array(controlSab) : null;

  // Poll the control byte — blocks (yields event loop) while paused
  async function checkControl() {
    if (!ctrl) return false; // no control = always run
    // Spin-wait while paused — yield every 200ms to avoid 100% CPU
    while (Atomics.load(ctrl, 0) === 1) {
      await new Promise(r => setTimeout(r, 200));
    }
    // Return true if abort was requested
    return Atomics.load(ctrl, 0) === 2;
  }

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

    // ── Phase 4a: EXIF writing pass (no thumbnails — keep pool fast) ─────────
    let processed = 0, fixed = 0, matched = 0, failed = 0;
    let writesIssued = 0;
    let trialLimitMessageSent = false;
    const startMs = Date.now();

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
      const percent   = Math.round((processed / uniqueMedia.length) * 100);
      // Log to terminal every 10%
      if (percent % 10 === 0) {
        const eta = etaSecs ? ` — ETA ${Math.round(etaSecs / 60)}m` : '';
        console.log(`[fossick] ${percent}% — ${processed.toLocaleString()} / ${uniqueMedia.length.toLocaleString()} photos${eta}`);
      }
      send('progress', {
        processed, total: uniqueMedia.length,
        fixed, matched, failed,
        percent,
        etaSecs,
      });
    }

    await withPool(uniqueMedia, CONCURRENCY, async (mediaPath) => {
      const shouldAbort = await checkControl();
      if (shouldAbort) return;

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

        const underLimit = !isLimited || writesIssued < trialLimit;
        if (underLimit) writesIssued++;

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

      processed++;
      if (row.sidecarFound) matched++;
      if (row.exifWritten)  fixed++;
      if (!row.sidecarFound && row.dateSource === 'none') failed++;

      if (isLimited && !trialLimitMessageSent && writesIssued >= trialLimit && !row.exifWritten && exifError === 'trial_limit') {
        trialLimitMessageSent = true;
        send('status', { phase: 'processing', message: `Trial limit reached: ${trialLimit} photos fixed. Remaining photos indexed but not written.` });
        send('trial-limit-hit', { limit: trialLimit });
      }

      pendingRows.push(row);
      if (pendingRows.length >= FLUSH_EVERY) flushPending();
      if (processed % FLUSH_EVERY === 0 || processed === uniqueMedia.length) reportProgress();
    });

    flushPending();
    await shutdownExifTool();

    // ── Phase 4b: Thumbnail generation (separate pass — doesn't block EXIF) ─
    // HEIC/video via ffmpeg can take 1-2s each; running separately means EXIF
    // completes at full speed and thumbnails run as a background phase.
    if (thumbDir) {
      const SHARP_EXTS  = new Set(['jpg','jpeg','png','gif','webp','bmp','tiff','tif','avif']);
      const FFMPEG_EXTS = new Set(['heic','heif','mov','mp4','m4v','avi','mkv','3gp']);

      // Load current rows from DB to get IDs (needed for UPDATE)
      const allRows = db.prepare(`SELECT id, file_path, filename FROM photos WHERE thumbnail_path IS NULL`).all();
      const updateThumb = db.prepare(`UPDATE photos SET thumbnail_path = ? WHERE id = ?`);

      let thumbDone = 0;
      const thumbTotal = allRows.length;

      send('status', { phase: 'thumbnails',
        message: `Generating thumbnails for ${thumbTotal.toLocaleString()} photos…` });

      // Use same concurrency for thumbnails
      await withPool(allRows, CONCURRENCY, async (photo) => {
        const shouldAbort = await checkControl();
        if (shouldAbort) return;

        const ext       = photo.filename.split('.').pop()?.toLowerCase() || '';
        const safeBase  = photo.file_path.replace(/[/\\:]/g, '_').slice(-120);
        const thumbPath = path.join(thumbDir, safeBase + '_t.jpg');

        // Skip if thumbnail already exists from a previous run
        if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 100) {
          updateThumb.run(thumbPath, photo.id);
          thumbDone++;
          return;
        }

        if (sharp && SHARP_EXTS.has(ext)) {
          try {
            await sharp(photo.file_path)
              .resize(280, 280, { fit: 'inside', withoutEnlargement: true })
              .rotate()
              .jpeg({ quality: 72 })
              .toFile(thumbPath);
            updateThumb.run(thumbPath, photo.id);
          } catch {}
        } else if (FFMPEG_EXTS.has(ext)) {
          try {
            await execFileAsync(FFMPEG_BIN, [
              '-i', photo.file_path,
              '-frames:v', '1',
              '-vf', 'scale=280:280:force_original_aspect_ratio=decrease',
              '-update', '1',
              '-y', thumbPath,
            ], { timeout: 20000 });
            if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 100) {
              updateThumb.run(thumbPath, photo.id);
            }
          } catch {}
        }

        thumbDone++;
        if (thumbDone % 100 === 0 || thumbDone === thumbTotal) {
          send('progress', {
            processed: thumbDone, total: thumbTotal,
            fixed, matched, failed,
            percent: Math.round((thumbDone / thumbTotal) * 100),
            etaSecs: null,
            phase: 'thumbnails',
          });
        }
      });
    }

    // ── Phase 5: Done ────────────────────────────────────────────────────────
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
