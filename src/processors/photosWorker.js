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

const devMode = process.env.FOSSICK_DEV === '1';
const log = (...a) => { if (devMode) log(...a); };

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
  log(`[fossick] ${phase}: ${message}`);
  send('status', { phase, message });
}

// Concurrency: half the CPUs, capped at 8, minimum 2
// Detect likely storage type from the work directory path.
// HDDs have limited random IOPS — high concurrency causes head thrashing.
// SSDs are I/O-bound and benefit from higher concurrency.
function detectOptimalConcurrency(workPath) {
  // On macOS, rotational status isn't directly queryable from Node.
  // Heuristic: external volumes and paths with /Volumes/ are often HDDs.
  // Internal SSD paths (/, /Users, /System) get full concurrency.
  // This is imperfect but conservative — HDD gets 3, SSD gets full cores.
  const cpus = os.cpus().length;
  if (workPath && (
    workPath.startsWith('/Volumes/') ||
    workPath.includes('/old/') ||
    workPath.includes('/backup/')
  )) {
    log('[fossick] Detected likely HDD path — using reduced concurrency (3) to avoid seek thrashing');
    return 3;
  }
  const full = Math.min(8, cpus);  // cap at 8, never oversubscribe
  log(`[fossick] Using ${full} concurrent ExifTool processes`);
  return full;
}

const CONCURRENCY = detectOptimalConcurrency(workerData.extractedFolder || workerData.zipPaths?.[0]);

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
  status('starting', 'Starting up…');
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

    // ── Resume: skip already-processed files ────────────────────────────────
    // Photos already in the DB were processed in a previous (interrupted) run.
    // We check by file_path — INSERT OR REPLACE would overwrite them anyway,
    // but skipping saves ExifTool calls and time.
    const alreadyDone = new Set(
      db.prepare(`SELECT file_path FROM photos WHERE exif_written = 1 OR sidecar_found = 1`).all().map(r => r.file_path)
    );
    const toProcess = alreadyDone.size > 0
      ? uniqueMedia.filter(p => !alreadyDone.has(p))
      : uniqueMedia;

    if (alreadyDone.size > 0) {
      status('resuming', `Resuming — skipping ${alreadyDone.size.toLocaleString()} already-processed photos, ${toProcess.length.toLocaleString()} remaining…`);
    }

    status('processing', `Processing ${toProcess.length.toLocaleString()} photos with ${CONCURRENCY} concurrent ExifTool processes…`);

    // ── Phase 4a: EXIF writing pass (no thumbnails — keep pool fast) ─────────
    let processed = 0, fixed = 0, matched = 0, failed = 0;
    let writesIssued = 0;
    let trialLimitMessageSent = false;
    const startMs = Date.now();

    const FLUSH_EVERY    = 200;   // DB flush interval
    const LOG_EVERY      = 500;   // terminal + UI progress interval
    let lastLogAt        = 0;
    let pendingRows      = [];

    function flushPending() {
      if (pendingRows.length === 0) return;
      insertBatch(pendingRows);
      pendingRows = [];
    }

    function reportProgress() {
      if (processed - lastLogAt < LOG_EVERY && processed < uniqueMedia.length) return;
      lastLogAt = processed;
      const elapsed  = Date.now() - startMs;
      const rate     = processed / (elapsed / 1000);
      const etaSecs  = rate > 0 ? Math.round((uniqueMedia.length - processed) / rate) : null;
      const percent  = Math.round((processed / uniqueMedia.length) * 100);
      const eta      = etaSecs ? ` — ETA ${Math.round(etaSecs / 60)}m` : '';
      log(`[fossick] ${percent}% — ${processed.toLocaleString()} / ${uniqueMedia.length.toLocaleString()} photos${eta}`);
      send('progress', { processed: processed + alreadyDone.size, total: uniqueMedia.length, fixed, matched, failed, percent, etaSecs });
    }

    await withPool(toProcess, CONCURRENCY, async (mediaPath) => {
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
      if (processed % LOG_EVERY === 0 || processed === uniqueMedia.length) reportProgress();
    });

    flushPending();
    await shutdownExifTool();

    // ── Phase 4b: Thumbnail generation — two-pass (fast then slow) ────────────
    //
    // Optimisations:
    //  1. sharp.concurrency(1) + THUMB_CONCURRENCY (cpus*2): each libvips call
    //     uses 1 thread so N parallel calls saturate all cores without contention.
    //  2. Try sharp for HEIC first — pre-built binaries include libheif (~20ms),
    //     fall back to sips only if sharp throws (~200ms process spawn).
    //  3. Two passes: images first (sharp), videos second (qlmanage/ffmpeg).
    //     Gallery is browsable as soon as all image thumbs are done.
    //  4. Pre-scanned existingThumbs Set — O(1) skip, no syscalls on re-runs.
    //  5. Batched DB writes — one transaction per 200 rows.
    if (thumbDir) {
      fs.mkdirSync(thumbDir, { recursive: true });

      // sharp.concurrency(1): single-threaded per call, run many in parallel
      if (sharp) sharp.concurrency(1);

      // Higher concurrency for CPU-bound thumbnail work vs I/O-bound ExifTool
      const cpuCount = os.cpus().length;
      const THUMB_CONCURRENCY = Math.min(cpuCount * 2, 24);
      log(`[fossick] thumbnail concurrency: ${THUMB_CONCURRENCY} (EXIF was ${CONCURRENCY})`);

      // File type buckets
      const SHARP_ALL  = new Set(['jpg','jpeg','png','gif','webp','bmp','tiff','tif','avif','heic','heif']);
      const VIDEO_EXTS = new Set(['mov','mp4','m4v','avi','mkv','3gp']);

      const allRows     = db.prepare(`SELECT id, file_path, filename FROM photos WHERE thumbnail_path IS NULL`).all();
      const updateThumb = db.prepare(`UPDATE photos SET thumbnail_path = ? WHERE id = ?`);

      // Pre-scan thumb dir — one readdirSync instead of existsSync per photo
      const existingThumbs = new Set(
        fs.readdirSync(thumbDir).filter(f => f.endsWith('_t.jpg'))
      );

      // Batched DB writes
      const THUMB_FLUSH = 200;
      let pendingThumbs = [];
      const flushThumbs = db.transaction((rows) => {
        for (const r of rows) updateThumb.run(r.path, r.id);
      });
      function queueThumb(thumbPath, id) {
        pendingThumbs.push({ path: thumbPath, id });
        if (pendingThumbs.length >= THUMB_FLUSH) {
          flushThumbs(pendingThumbs);
          pendingThumbs = [];
        }
      }

      // Split rows into fast (images) and slow (videos)
      const fastRows  = allRows.filter(r => SHARP_ALL.has(r.filename.split('.').pop()?.toLowerCase() || ''));
      const videoRows = allRows.filter(r => VIDEO_EXTS.has(r.filename.split('.').pop()?.toLowerCase() || ''));

      let thumbDone = 0;
      const thumbTotal   = allRows.length;
      const thumbStartMs = Date.now();

      function reportProgress() {
        if (thumbDone % 100 !== 0 && thumbDone !== thumbTotal) return;
        const elapsed = Date.now() - thumbStartMs;
        const rate    = thumbDone / (elapsed / 1000);
        const etaSecs = rate > 0 ? Math.round((thumbTotal - thumbDone) / rate) : null;
        const pct     = Math.round((thumbDone / thumbTotal) * 100);
        if (thumbDone % 500 === 0 || thumbDone === thumbTotal) {
          const eta = etaSecs ? ` — ETA ${Math.round(etaSecs / 60)}m` : '';
          log(`[fossick] thumbnails ${pct}% — ${thumbDone.toLocaleString()} / ${thumbTotal.toLocaleString()}${eta}`);
        }
        send('progress', { processed: thumbDone, total: thumbTotal, fixed, matched, failed, percent: pct, etaSecs, phase: 'thumbnails' });
      }

      send('status', { phase: 'thumbnails',
        message: `Generating thumbnails for ${thumbTotal.toLocaleString()} photos…` });

      // ── Pass 1: images (fast — all via sharp, HEIC tried first) ────────────────────
      await withPool(fastRows, THUMB_CONCURRENCY, async (photo) => {
        if (await checkControl()) return;

        const ext       = photo.filename.split('.').pop()?.toLowerCase() || '';
        const safeBase  = photo.file_path.replace(/[/\\:]/g, '_').slice(-120);
        const thumbFile = safeBase + '_t.jpg';
        const thumbPath = path.join(thumbDir, thumbFile);

        if (existingThumbs.has(thumbFile)) {
          queueThumb(thumbPath, photo.id);
          thumbDone++;
          reportProgress();
          return;
        }

        let done = false;

        // Try sharp — handles JPG/PNG/AVIF/GIF and HEIC (if libheif available)
        if (sharp) {
          try {
            await sharp(photo.file_path)
              .resize(280, 280, { fit: 'inside', withoutEnlargement: true })
              .rotate()
              .jpeg({ quality: 72 })
              .toFile(thumbPath);
            queueThumb(thumbPath, photo.id);
            done = true;
          } catch {
            // Fall through to sips for HEIC without libheif
          }
        }

        // Fallback: sips for HEIC on macOS when sharp doesn't have libheif
        if (!done && (ext === 'heic' || ext === 'heif') && process.platform === 'darwin') {
          try {
            await execFileAsync('sips', [
              '-s', 'format', 'jpeg', '-z', '280', '280',
              photo.file_path, '--out', thumbPath,
            ], { timeout: 20000 });
            try {
              if (fs.statSync(thumbPath).size > 100) { queueThumb(thumbPath, photo.id); done = true; }
              else log(`[fossick] thumb empty (sips) ${photo.filename}`);
            } catch {}
          } catch (err) {
            log(`[fossick] thumb failed (sips) ${photo.filename}: ${err.message}`);
          }
        }

        if (!done) log(`[fossick] thumb unhandled ${photo.filename}`);
        thumbDone++;
        reportProgress();
      });

      // Flush image thumbs — gallery is now fully browsable
      if (pendingThumbs.length > 0) { flushThumbs(pendingThumbs); pendingThumbs = []; }

      // ── Pass 2: videos (slow — qlmanage / ffmpeg) ───────────────────────────
      if (videoRows.length > 0) {
        send('status', { phase: 'thumbnails',
          message: `Generating thumbnails for ${videoRows.length.toLocaleString()} videos…` });

        await withPool(videoRows, CONCURRENCY, async (photo) => {
          if (await checkControl()) return;

          const safeBase  = photo.file_path.replace(/[/\\:]/g, '_').slice(-120);
          const thumbFile = safeBase + '_t.jpg';
          const thumbPath = path.join(thumbDir, thumbFile);

          if (existingThumbs.has(thumbFile)) {
            queueThumb(thumbPath, photo.id);
            thumbDone++;
            reportProgress();
            return;
          }

          if (process.platform === 'darwin') {
            try {
              const tmpOut = require('os').tmpdir() + '/fossick_ql_' + Date.now() + '_' + Math.random().toString(36).slice(2);
              fs.mkdirSync(tmpOut, { recursive: true });
              await execFileAsync('qlmanage', [
                '-t', '-s', '280', '-o', tmpOut, photo.file_path,
              ], { timeout: 30000, env: { ...process.env, QL_PLUGIN_DISABLE_COMPRESSION: '1' } });
              const qlOut = path.join(tmpOut, path.basename(photo.file_path) + '.png');
              try {
                if (fs.statSync(qlOut).size > 100) { fs.renameSync(qlOut, thumbPath); queueThumb(thumbPath, photo.id); }
              } catch {}
              try { fs.rmSync(tmpOut, { recursive: true }); } catch {}
            } catch (err) {
              log(`[fossick] thumb failed (qlmanage) ${photo.filename}: ${err.message}`);
            }
          } else {
            try {
              await execFileAsync(FFMPEG_BIN, [
                '-i', photo.file_path, '-frames:v', '1',
                '-vf', 'scale=280:280:force_original_aspect_ratio=decrease',
                '-update', '1', '-y', thumbPath,
              ], { timeout: 20000 });
              try {
                if (fs.statSync(thumbPath).size > 100) queueThumb(thumbPath, photo.id);
                else log(`[fossick] thumb empty (ffmpeg) ${photo.filename}`);
              } catch {}
            } catch (err) {
              log(`[fossick] thumb failed (ffmpeg) ${photo.filename}: ${err.message}`);
            }
          }

          thumbDone++;
          reportProgress();
        });
      }

      // Final flush
      if (pendingThumbs.length > 0) { flushThumbs(pendingThumbs); pendingThumbs = []; }
    }

    // ── Phase 5: Album population ─────────────────────────────────────────────
    // Album folders are subdirs of Google Photos that are NOT year folders.
    // Each album dir contains copies of year-folder photos; we match by filename.
    if (manifest.albumDirs && manifest.albumDirs.length > 0) {
      status('albums', `Scanning ${manifest.albumDirs.length} album folder(s) for memberships…`);

      const ALBUM_MEDIA_EXTS = new Set([
        'jpg','jpeg','png','gif','webp','heic','heif','bmp','tiff','tif','avif',
        'mov','mp4','m4v','avi','mkv','3gp',
      ]);

      const stmtInsertAlbum   = db.prepare(`INSERT INTO albums (name, photo_count, cover_photo_id) VALUES (?, 0, NULL)`);
      const stmtInsertPA      = db.prepare(`INSERT OR IGNORE INTO photo_albums (photo_id, album_id) VALUES (?, ?)`);
      const stmtUpdateAlbum   = db.prepare(`UPDATE albums SET photo_count = ?, cover_photo_id = ? WHERE id = ?`);
      const stmtDeleteAlbum   = db.prepare(`DELETE FROM albums WHERE id = ?`);
      const stmtGetByFilename = db.prepare(`SELECT id FROM photos WHERE filename = ? LIMIT 1`);
      const stmtGetCover      = db.prepare(`
        SELECT p.id FROM photos p
        JOIN photo_albums pa ON p.id = pa.photo_id
        WHERE pa.album_id = ?
        ORDER BY p.date_ts ASC NULLS LAST LIMIT 1
      `);

      let albumsCreated = 0;

      for (const albumDir of manifest.albumDirs) {
        let dirEntries;
        try { dirEntries = fs.readdirSync(albumDir.path); } catch { continue; }

        const mediaFilenames = dirEntries.filter(f => {
          const dot = f.lastIndexOf('.');
          if (dot < 0) return false;
          return ALBUM_MEDIA_EXTS.has(f.slice(dot + 1).toLowerCase());
        });

        if (mediaFilenames.length === 0) continue;

        const albumId = stmtInsertAlbum.run(albumDir.name).lastInsertRowid;

        const matchedCount = db.transaction((names) => {
          let count = 0;
          for (const filename of names) {
            const row = stmtGetByFilename.get(filename);
            if (row) {
              stmtInsertPA.run(row.id, albumId);
              count++;
            }
          }
          return count;
        })(mediaFilenames);

        if (matchedCount > 0) {
          const cover = stmtGetCover.get(albumId);
          stmtUpdateAlbum.run(matchedCount, cover?.id ?? null, albumId);
          albumsCreated++;
        } else {
          stmtDeleteAlbum.run(albumId);
        }
      }

      status('albums', `Albums populated: ${albumsCreated.toLocaleString()} album(s).`);
      send('albums-summary', { total: albumsCreated });
    }

    // ── Phase 6: Done ────────────────────────────────────────────────────────
    status('done', `Done — fixed ${fixed.toLocaleString()} of ${toProcess.length.toLocaleString()} photos (${alreadyDone.size.toLocaleString()} skipped from previous run).`);
    send('summary', { processed: processed + alreadyDone.size, fixed, matched, failed });

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
