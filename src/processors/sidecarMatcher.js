// src/processors/sidecarMatcher.js
// The core matching algorithm.
//
// Four strategies, tried in order:
//   1. Exact — old format:  IMG.jpg → IMG.jpg.json
//   2. Exact — new format:  IMG.jpg → IMG.jpg.supplemental-metadata.json
//   3. Truncated O(1):      Google truncates sidecar names at 46 chars since 2024
//   4. Edited / duplicate:  IMG-edited.jpg → IMG.jpg,  IMG(1).jpg → IMG.jpg
//
// Two indexes are built so every lookup is O(1):
//   primary: basename.lower → [paths]
//   prefix:  first-20-chars → [paths]   (replaces the old O(N) fallback scan)
//
// When multiple JSONs share a key (same filename, different year/album folders),
// the one in the same directory as the media file wins.

'use strict';

const path = require('path');
const fs   = require('fs');

const MEDIA_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp',
  '.tiff', '.tif', '.heic', '.heif', '.avif',
  '.mp4', '.mov', '.avi', '.mkv', '.3gp', '.m4v',
  '.wmv', '.mts', '.m2ts',
]);

// ── Async directory walker ────────────────────────────────────────────────────
// Uses fs.promises.opendir() — non-blocking, keeps the worker thread alive
// for IPC messages and prevents "not responding" on HDD / NAS / SMB shares.

async function walkPhotosDirectory(photosDir) {
  const mediaFiles = [];
  const jsonFiles  = [];

  async function walk(dir) {
    let dirHandle;
    try {
      dirHandle = await fs.promises.opendir(dir);
    } catch {
      return;
    }
    for await (const entry of dirHandle) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (MEDIA_EXTENSIONS.has(ext)) mediaFiles.push(fullPath);
        else if (ext === '.json')       jsonFiles.push(fullPath);
      }
      // symlinks skipped — no cycle risk
    }
  }

  await walk(photosDir);
  return { mediaFiles, jsonFiles };
}

// ── Media-only walker (for non-Google-Photos Takeout parts) ──────────────────
// Walks `rootDir` recursively, collecting media files.
// Skips `excludeDir` subtree entirely (avoids re-walking Google Photos).
// Does NOT collect JSON files — sidecar matching doesn't apply outside
// the Google Photos folder structure.

async function walkForMediaOnly(rootDir, excludeDir) {
  const mediaFiles = [];
  // Normalise excludeDir for reliable prefix matching
  const excludeNorm = excludeDir ? path.normalize(excludeDir) + path.sep : null;

  async function walk(dir) {
    // Skip the excluded subtree
    if (excludeNorm && (path.normalize(dir) + path.sep).startsWith(excludeNorm)) return;

    let dirHandle;
    try {
      dirHandle = await fs.promises.opendir(dir);
    } catch {
      return;
    }
    for await (const entry of dirHandle) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (MEDIA_EXTENSIONS.has(ext)) mediaFiles.push(fullPath);
      }
    }
  }

  await walk(rootDir);
  return mediaFiles;
}

// ── Dual JSON index ───────────────────────────────────────────────────────────

function buildJsonIndex(jsonFiles) {
  const primary = new Map(); // full basename.lower → [paths]
  const prefix  = new Map(); // first 20 chars → [paths]  (O(1) truncation fallback)

  for (const p of jsonFiles) {
    const key = path.basename(p).toLowerCase();

    if (!primary.has(key)) primary.set(key, []);
    primary.get(key).push(p);

    const pfx = key.slice(0, 20);
    if (!prefix.has(pfx)) prefix.set(pfx, []);
    prefix.get(pfx).push(p);
  }

  return { primary, prefix };
}

// ── Directory-preference resolver ─────────────────────────────────────────────
// Fixes basename collision: Google exports the same filename in multiple folders.
// Prefer the sidecar that lives in the same directory as the media file.

function bestMatch(paths, mediaDir) {
  if (!paths || paths.length === 0) return null;
  if (paths.length === 1) return paths[0];
  return paths.find(p => path.dirname(p) === mediaDir) || paths[0];
}

// ── Core matching algorithm ───────────────────────────────────────────────────

function findSidecar(mediaPath, jsonIndex) {
  const { primary, prefix: prefixIdx } = jsonIndex;
  const mediaDir  = path.dirname(mediaPath);
  const base      = path.basename(mediaPath);
  const baseLower = base.toLowerCase();

  // Strategy 1: old format
  const s1 = primary.get(baseLower + '.json');
  if (s1) return bestMatch(s1, mediaDir);

  // Strategy 2: new format
  const s2 = primary.get(baseLower + '.supplemental-metadata.json');
  if (s2) return bestMatch(s2, mediaDir);

  // Strategy 3: truncated sidecar — O(1)
  // Google truncates the full sidecar filename (incl .json) to 46 chars:
  //   first 42 chars of full name + ".json"
  const fullExpected = base + '.supplemental-metadata.json';
  if (fullExpected.length > 46) {
    // Primary O(1) lookup: compute the exact truncated key Google produces
    const truncKey = fullExpected.slice(0, 42).toLowerCase() + '.json';
    const s3a = primary.get(truncKey);
    if (s3a) return bestMatch(s3a, mediaDir);

    // Secondary O(1) lookup: use the prefix index for edge cases where
    // Google's truncation point varies by a character across export versions
    const pfx = fullExpected.slice(0, 20).toLowerCase();
    const s3b = prefixIdx.get(pfx);
    if (s3b) {
      const candidates = s3b.filter(p => {
        const k = path.basename(p).toLowerCase();
        return k.endsWith('.json') && k !== baseLower + '.json';
      });
      const match = bestMatch(candidates, mediaDir);
      if (match) return match;
    }
  }

  // Strategy 4a: edited suffix — "IMG_1234-edited.jpg" → "IMG_1234.jpg"
  const editedMatch = base.match(/^(.+?)[-_](edited|bearbeitet|modifi[eé])(\.[^.]+)$/i);
  if (editedMatch) {
    const r = findSidecar(path.join(mediaDir, editedMatch[1] + editedMatch[3]), jsonIndex);
    if (r) return r;
  }
  const hyphenMatch = base.match(/^(.+)-[a-z]+(\.[^.]+)$/i);
  if (hyphenMatch && hyphenMatch[1].length > 3) {
    const r = findSidecar(path.join(mediaDir, hyphenMatch[1] + hyphenMatch[2]), jsonIndex);
    if (r) return r;
  }

  // Strategy 4b: duplicate number — "IMG_1234(1).jpg" → "IMG_1234.jpg"
  const dupMatch = base.match(/^(.+?)[ ]?\((\d+)\)(\.[^.]+)$/);
  if (dupMatch) {
    const r = findSidecar(path.join(mediaDir, dupMatch[1] + dupMatch[3]), jsonIndex);
    if (r) return r;
  }

  return null;
}

// ── Filename date extraction — always UTC ─────────────────────────────────────

function dateFromFilename(filename) {
  const base = path.basename(filename, path.extname(filename));

  const pxl = base.match(/(?:^|[_-])PXL_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/i);
  if (pxl) return utcMs(pxl[1], pxl[2], pxl[3], pxl[4], pxl[5], pxl[6]);

  const img = base.match(/(?:^|[_-])IMG_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/i);
  if (img) return utcMs(img[1], img[2], img[3], img[4], img[5], img[6]);

  const vid = base.match(/(?:^|[_-])VID_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/i);
  if (vid) return utcMs(vid[1], vid[2], vid[3], vid[4], vid[5], vid[6]);

  const ss = base.match(/Screenshot[_-](\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})/i);
  if (ss) return utcMs(ss[1], ss[2], ss[3], ss[4], ss[5], ss[6]);

  const wa = base.match(/(?:IMG|VID)-(\d{4})(\d{2})(\d{2})-WA/i);
  if (wa) return utcMs(wa[1], wa[2], wa[3], '12', '00', '00');

  const d = base.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (d) {
    const ts = Date.UTC(+d[1], +d[2] - 1, +d[3], 12, 0, 0);
    if (!isNaN(ts) && ts > 0) return ts;
  }

  return null;
}

function utcMs(y, mo, d, h, min, s) {
  const ts = Date.UTC(+y, +mo - 1, +d, +h, +min, +s);
  if (isNaN(ts) || ts < 631152000000 || ts > 2208988800000) return null;
  return ts;
}

// ── Deduplication ─────────────────────────────────────────────────────────────

function deduplicateMedia(mediaFiles) {
  const seen = new Set();
  return mediaFiles.filter(p => {
    const key = path.basename(p).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  walkPhotosDirectory,
  walkForMediaOnly,
  buildJsonIndex,
  findSidecar,
  dateFromFilename,
  deduplicateMedia,
  MEDIA_EXTENSIONS,
};
// src/processors/sidecarMatcher.js
// The core matching algorithm.
//
// Four strategies, tried in order:
//   1. Exact — old format:  IMG.jpg → IMG.jpg.json
//   2. Exact — new format:  IMG.jpg → IMG.jpg.supplemental-metadata.json
//   3. Truncated O(1):      Google truncates sidecar names at 46 chars since 2024
//   4. Edited / duplicate:  IMG-edited.jpg → IMG.jpg,  IMG(1).jpg → IMG.jpg
//
// Two indexes are built so every lookup is O(1):
//   primary: basename.lower → [paths]
//   prefix:  first-20-chars → [paths]   (replaces the old O(N) fallback scan)
//
// When multiple JSONs share a key (same filename, different year/album folders),
// the one in the same directory as the media file wins.

'use strict';

const path = require('path');
const fs   = require('fs');

const MEDIA_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp',
  '.tiff', '.tif', '.heic', '.heif', '.avif',
  '.mp4', '.mov', '.avi', '.mkv', '.3gp', '.m4v',
  '.wmv', '.mts', '.m2ts',
]);

// ── Async directory walker ────────────────────────────────────────────────────
// Uses fs.promises.opendir() — non-blocking, keeps the worker thread alive
// for IPC messages and prevents "not responding" on HDD / NAS / SMB shares.

async function walkPhotosDirectory(photosDir) {
  const mediaFiles = [];
  const jsonFiles  = [];

  async function walk(dir) {
    let dirHandle;
    try {
      dirHandle = await fs.promises.opendir(dir);
    } catch {
      return;
    }
    for await (const entry of dirHandle) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (MEDIA_EXTENSIONS.has(ext)) mediaFiles.push(fullPath);
        else if (ext === '.json')       jsonFiles.push(fullPath);
      }
      // symlinks skipped — no cycle risk
    }
  }

  await walk(photosDir);
  return { mediaFiles, jsonFiles };
}

// ── Media-only walker (for non-Google-Photos Takeout parts) ──────────────────
// Walks `rootDir` recursively, collecting media files.
// Skips `excludeDir` subtree entirely (avoids re-walking Google Photos).
// Does NOT collect JSON files — sidecar matching doesn't apply outside
// the Google Photos folder structure.

async function walkForMediaOnly(rootDir, excludeDir) {
  const mediaFiles = [];
  // Normalise excludeDir for reliable prefix matching
  const excludeNorm = excludeDir ? path.normalize(excludeDir) + path.sep : null;

  async function walk(dir) {
    // Skip the excluded subtree
    if (excludeNorm && (path.normalize(dir) + path.sep).startsWith(excludeNorm)) return;

    let dirHandle;
    try {
      dirHandle = await fs.promises.opendir(dir);
    } catch {
      return;
    }
    for await (const entry of dirHandle) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (MEDIA_EXTENSIONS.has(ext)) mediaFiles.push(fullPath);
      }
    }
  }

  await walk(rootDir);
  return mediaFiles;
}

// ── Dual JSON index ───────────────────────────────────────────────────────────

function buildJsonIndex(jsonFiles) {
  const primary = new Map(); // full basename.lower → [paths]
  const prefix  = new Map(); // first 20 chars → [paths]  (O(1) truncation fallback)

  for (const p of jsonFiles) {
    const key = path.basename(p).toLowerCase();

    if (!primary.has(key)) primary.set(key, []);
    primary.get(key).push(p);

    const pfx = key.slice(0, 20);
    if (!prefix.has(pfx)) prefix.set(pfx, []);
    prefix.get(pfx).push(p);
  }

  return { primary, prefix };
}

// ── Directory-preference resolver ─────────────────────────────────────────────
// Fixes basename collision: Google exports the same filename in multiple folders.
// Prefer the sidecar that lives in the same directory as the media file.

function bestMatch(paths, mediaDir) {
  if (!paths || paths.length === 0) return null;
  if (paths.length === 1) return paths[0];
  return paths.find(p => path.dirname(p) === mediaDir) || paths[0];
}

// ── Core matching algorithm ───────────────────────────────────────────────────

function findSidecar(mediaPath, jsonIndex) {
  const { primary, prefix: prefixIdx } = jsonIndex;
  const mediaDir  = path.dirname(mediaPath);
  const base      = path.basename(mediaPath);
  const baseLower = base.toLowerCase();

  // Strategy 1: old format
  const s1 = primary.get(baseLower + '.json');
  if (s1) return bestMatch(s1, mediaDir);

  // Strategy 2: new format
  const s2 = primary.get(baseLower + '.supplemental-metadata.json');
  if (s2) return bestMatch(s2, mediaDir);

  // Strategy 3: truncated sidecar — O(1)
  // Google truncates the full sidecar filename (incl .json) to 46 chars:
  //   first 42 chars of full name + ".json"
  const fullExpected = base + '.supplemental-metadata.json';
  if (fullExpected.length > 46) {
    // Primary O(1) lookup: compute the exact truncated key Google produces
    const truncKey = fullExpected.slice(0, 42).toLowerCase() + '.json';
    const s3a = primary.get(truncKey);
    if (s3a) return bestMatch(s3a, mediaDir);

    // Secondary O(1) lookup: use the prefix index for edge cases where
    // Google's truncation point varies by a character across export versions
    const pfx = fullExpected.slice(0, 20).toLowerCase();
    const s3b = prefixIdx.get(pfx);
    if (s3b) {
      const candidates = s3b.filter(p => {
        const k = path.basename(p).toLowerCase();
        return k.endsWith('.json') && k !== baseLower + '.json';
      });
      const match = bestMatch(candidates, mediaDir);
      if (match) return match;
    }
  }

  // Strategy 4a: edited suffix — "IMG_1234-edited.jpg" → "IMG_1234.jpg"
  const editedMatch = base.match(/^(.+?)[-_](edited|bearbeitet|modifi[eé])(\.[^.]+)$/i);
  if (editedMatch) {
    const r = findSidecar(path.join(mediaDir, editedMatch[1] + editedMatch[3]), jsonIndex);
    if (r) return r;
  }
  const hyphenMatch = base.match(/^(.+)-[a-z]+(\.[^.]+)$/i);
  if (hyphenMatch && hyphenMatch[1].length > 3) {
    const r = findSidecar(path.join(mediaDir, hyphenMatch[1] + hyphenMatch[2]), jsonIndex);
    if (r) return r;
  }

  // Strategy 4b: duplicate number — "IMG_1234(1).jpg" → "IMG_1234.jpg"
  const dupMatch = base.match(/^(.+?)[ ]?\((\d+)\)(\.[^.]+)$/);
  if (dupMatch) {
    const r = findSidecar(path.join(mediaDir, dupMatch[1] + dupMatch[3]), jsonIndex);
    if (r) return r;
  }

  return null;
}

// ── Filename date extraction — always UTC ─────────────────────────────────────

function dateFromFilename(filename) {
  const base = path.basename(filename, path.extname(filename));

  const pxl = base.match(/(?:^|[_-])PXL_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/i);
  if (pxl) return utcMs(pxl[1], pxl[2], pxl[3], pxl[4], pxl[5], pxl[6]);

  const img = base.match(/(?:^|[_-])IMG_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/i);
  if (img) return utcMs(img[1], img[2], img[3], img[4], img[5], img[6]);

  const vid = base.match(/(?:^|[_-])VID_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/i);
  if (vid) return utcMs(vid[1], vid[2], vid[3], vid[4], vid[5], vid[6]);

  const ss = base.match(/Screenshot[_-](\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})/i);
  if (ss) return utcMs(ss[1], ss[2], ss[3], ss[4], ss[5], ss[6]);

  const wa = base.match(/(?:IMG|VID)-(\d{4})(\d{2})(\d{2})-WA/i);
  if (wa) return utcMs(wa[1], wa[2], wa[3], '12', '00', '00');

  const d = base.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (d) {
    const ts = Date.UTC(+d[1], +d[2] - 1, +d[3], 12, 0, 0);
    if (!isNaN(ts) && ts > 0) return ts;
  }

  return null;
}

function utcMs(y, mo, d, h, min, s) {
  const ts = Date.UTC(+y, +mo - 1, +d, +h, +min, +s);
  if (isNaN(ts) || ts < 631152000000 || ts > 2208988800000) return null;
  return ts;
}

// ── Deduplication ─────────────────────────────────────────────────────────────

function deduplicateMedia(mediaFiles) {
  const seen = new Set();
  return mediaFiles.filter(p => {
    const key = path.basename(p).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  walkPhotosDirectory,
  walkForMediaOnly,
  buildJsonIndex,
  findSidecar,
  dateFromFilename,
  deduplicateMedia,
  MEDIA_EXTENSIONS,
};
