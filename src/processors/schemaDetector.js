// src/processors/schemaDetector.js
// Scans an extracted Takeout folder and returns a manifest of detected schemas.
// Handles Google's multi-language folder names (English, German, French, Spanish, etc.)

const fs = require('fs');
const path = require('path');

// Known folder names for each schema, across languages Google uses
const PHOTOS_FOLDERS   = new Set(['Google Photos', 'Google Fotos', 'Google Foto', 'Foto Google']);
const LOCATION_FOLDERS = new Set([
  'Location History', 'Standortverlauf', 'Historique des positions',
  'Historial de ubicaciones', 'Cronologia', 'Locatiegeschiedenis',
]);
const MAIL_FOLDERS     = new Set(['Mail', 'Gmail']);
const YOUTUBE_FOLDERS  = new Set([
  'YouTube and YouTube Music', 'YouTube', 'YouTube and YouTube Music (1)',
]);

/**
 * Detect which Takeout schemas are present in an extracted directory.
 *
 * @param {string} takeoutDir - Root of the extracted Takeout archive
 * @returns {object} manifest
 * @returns {string|null}   manifest.photos       - Path to Google Photos folder
 * @returns {string|null}   manifest.recordsJson  - Path to Records.json (location history)
 * @returns {string|null}   manifest.semanticDir  - Path to Semantic Location History folder
 * @returns {string|null}   manifest.mboxPath     - Path to first .mbox file
 * @returns {string|null}   manifest.youtubeHtml  - Path to watch-history.html
 * @returns {Array}         manifest.albumDirs    - [{name, path}] album subdirs in Google Photos
 */
function detectSchemas(takeoutDir) {
  const manifest = {
    photos:       null,
    recordsJson:  null,
    semanticDir:  null,
    mboxPath:     null,
    youtubeHtml:  null,
    albumDirs:    [],
  };

  // Find the real Takeout root — Google Photos (and other schema folders) may be
  // nested inside one or more wrapper directories (e.g. fake-takeout/Takeout/Google Photos/).
  // Walk up to 4 levels deep to find a directory that contains a known schema folder.
  const root = findTakeoutRoot(takeoutDir, 4);
  if (!root) return manifest; // nothing recognisable found

  const entries = safeReaddir(root);

  for (const entry of entries) {
    const fullPath = path.join(root, entry);

    // Google Photos
    if (PHOTOS_FOLDERS.has(entry)) {
      manifest.photos = fullPath;
    }

    // Location History
    if (LOCATION_FOLDERS.has(entry)) {
      const recordsPath  = path.join(fullPath, 'Records.json');
      const semanticPath = path.join(fullPath, 'Semantic Location History');

      if (fs.existsSync(recordsPath))   manifest.recordsJson = recordsPath;
      if (fs.existsSync(semanticPath))  manifest.semanticDir = semanticPath;
    }

    // Gmail / Mail
    if (MAIL_FOLDERS.has(entry)) {
      const mboxFiles = safeReaddir(fullPath).filter(f => f.endsWith('.mbox'));
      if (mboxFiles.length > 0) {
        // Pick the largest .mbox (most complete) if multiple exist
        const sorted = mboxFiles
          .map(f => ({ f, size: safeFileSize(path.join(fullPath, f)) }))
          .sort((a, b) => b.size - a.size);
        manifest.mboxPath = path.join(fullPath, sorted[0].f);
      }
    }

    // YouTube
    if (YOUTUBE_FOLDERS.has(entry)) {
      // Standard location: YouTube and YouTube Music/history/watch-history.html
      const candidates = [
        path.join(fullPath, 'history', 'watch-history.html'),
        path.join(fullPath, 'watch-history.html'),
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) { manifest.youtubeHtml = c; break; }
      }
    }
  }

  // Detect album subdirectories inside the Google Photos folder.
  // Album folders are any subdirectory that is NOT a year folder.
  // Year folders always end with a space + 4-digit year in every locale
  // (e.g. "Photos from 2023", "Fotos von 2022").
  if (manifest.photos) {
    manifest.albumDirs = _detectAlbumDirs(manifest.photos);
  }

  return manifest;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Scan the Google Photos root for album subdirectories.
 * Album folders = subdirs that are NOT year folders and NOT hidden.
 *
 * @param {string} photosRoot - Path to the Google Photos folder
 * @returns {Array<{name:string, path:string}>}
 */
// Google-generated year folder prefixes across known locales.
// Format is always "<prefix><4-digit year>" — these names are never user-chosen.
const YEAR_FOLDER_PREFIXES = [
  'Photos from ',  // English
  'Fotos von ',    // German
  'Photos de ',    // French
  'Fotos de ',     // Spanish / Portuguese
  'Foto del ',     // Italian
  'Foto van ',     // Dutch
  'Zdjęcia z ',    // Polish
];

function _isYearFolder(name) {
  // Must end in 4 digits
  if (!/\d{4}$/.test(name)) return false;
  for (const prefix of YEAR_FOLDER_PREFIXES) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}

function _detectAlbumDirs(photosRoot) {
  const albumDirs = [];
  const entries = safeReaddir(photosRoot);
  for (const entry of entries) {
    // Skip hidden entries, macOS metadata folders, and Google's Trash folder
    if (entry.startsWith('.') || entry === '__MACOSX' || entry === 'Trash') continue;
    const fullPath = path.join(photosRoot, entry);
    try {
      if (!fs.statSync(fullPath).isDirectory()) continue;
    } catch { continue; }
    // Skip Google-generated year folders ("Photos from 2023", "Fotos von 2022", etc.)
    if (_isYearFolder(entry)) continue;
    albumDirs.push({ name: entry, path: fullPath });
  }
  return albumDirs;
}

/**
 * Recursively search for the directory that contains known Takeout schema folders.
 * Handles any number of wrapper directories (fake-takeout/, Takeout/, etc.)
 *
 * @param {string} dir      - Directory to search from
 * @param {number} maxDepth - How many levels deep to search
 * @returns {string|null}   - The directory containing schema folders, or null
 */
function findTakeoutRoot(dir, maxDepth) {
  if (maxDepth < 0) return null;

  const entries = safeReaddir(dir);

  // Does this directory directly contain a known schema folder?
  const hasSchema = entries.some(e =>
    PHOTOS_FOLDERS.has(e) ||
    LOCATION_FOLDERS.has(e) ||
    MAIL_FOLDERS.has(e) ||
    YOUTUBE_FOLDERS.has(e)
  );
  if (hasSchema) return dir;

  // Edge case: user selected the Google Photos folder itself
  // Treat it as a single-schema root by wrapping it in a synthetic manifest check
  const basename = path.basename(dir);
  if (PHOTOS_FOLDERS.has(basename)) {
    // Return the parent so the normal loop finds it
    return path.dirname(dir);
  }

  // Otherwise recurse into subdirectories (skip obvious non-Takeout dirs)
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    try {
      if (fs.statSync(fullPath).isDirectory()) {
        const found = findTakeoutRoot(fullPath, maxDepth - 1);
        if (found) return found;
      }
    } catch {
      // skip unreadable
    }
  }

  return null;
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function safeFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

module.exports = { detectSchemas };
// src/processors/schemaDetector.js
// Scans an extracted Takeout folder and returns a manifest of detected schemas.
// Handles Google's multi-language folder names (English, German, French, Spanish, etc.)

