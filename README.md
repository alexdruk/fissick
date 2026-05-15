# Fisssicks — Module 1: Photos EXIF Fixer

Electron desktop app. Local-first. $29 one-time.  
Fixes Google Takeout photo metadata for import into Apple Photos, Lightroom, and NAS.

---

## Quick start (3 commands)

```bash
cd fisssicks
npm install
npm start
```

That's it for development. The app opens immediately.

---

## Prerequisites

| Tool | Version | Check |
|------|---------|-------|
| Node.js | 20+ | `node --version` |
| npm | 10+ | `npm --version` |

Node 20 or newer is required. Electron 31 uses Node 20 internally.

---

## Project structure

```
fisssicks/
├── package.json
├── forge.config.js          ← Electron Forge build config
├── src/
│   ├── main.js              ← Electron main process (window, IPC, SQLite)
│   ├── preload.js           ← contextBridge: exposes window.tt to renderer
│   ├── processors/
│   │   ├── zipExtractor.js  ← Streaming ZIP extraction (never loads full file)
│   │   ├── schemaDetector.js← Scans extracted folder for Photos/Location/Mail/YT
│   │   ├── sidecarMatcher.js← 4-strategy media↔JSON matching algorithm
│   │   ├── exifWriter.js    ← exiftool-vendored wrapper: writes dates + GPS
│   │   └── photosWorker.js  ← Worker Thread: runs the full pipeline off main thread
│   └── renderer/
│       ├── index.html       ← All UI: import / processing / results views
│       └── app.js           ← Renderer JS: state machine, IPC calls, photo list
└── tests/
    └── matcher.test.js      ← Unit tests for sidecarMatcher (no framework needed)
```

---

## First thing to run after install

Before touching the Electron UI, verify the sidecar matcher works correctly:

```bash
node tests/matcher.test.js
```

Expected output:
```
── Strategy 1: Old format (pre-2024) ────────────────────────────
  ✓  standard old format
  ✓  HEIC old format
  ...

  22 passed  |  0 failed

  All tests pass. Matcher is ready.
```

If any tests fail, fix the matcher before running the app.

---

## What Module 1 does

### The problem it solves

Google changed Takeout sidecar filenames in late 2024 without announcement:

```
Old (pre-2024):  IMG_1234.jpg.json
New (2024+):     IMG_1234.jpg.supplemental-metadata.json
Truncated:       PXL_20230815_142536789.jpg.supplemental-m.json  ← 46-char limit
```

This broke GPTH (unmaintained since Jan 2025), most GitHub scripts, and partial
tools like MetadataFixer that haven't shipped a fix yet.

### What it does

1. **Drag-drop ZIPs** — accepts multiple Takeout ZIP files, streams them to a
   temp directory (never loads 500GB into RAM)
2. **Sidecar matching** — 4-strategy algorithm handles old format, new format,
   truncated filenames, edited copies, duplicate numbering
3. **EXIF writing** — writes `DateTimeOriginal`, `CreateDate`, `GPSLatitude`,
   `GPSLongitude`, `GPSAltitude`, `ImageDescription` into the original files
4. **SQLite index** — stores all results for fast browsing without re-parsing
5. **Results dashboard** — photo list with filter tabs (all / fixed / no sidecar / no date)

### What it does NOT do (yet)
- Location Timeline map (Module 2, Sprint 5)
- Gmail MBOX viewer (v1.1)
- YouTube history (v1.1)

---

## Known issues and workarounds

### Issue: ExifTool binary not found after `npm install`

Symptom: Processing starts but immediately reports an ExifTool error.

Cause: `exiftool-vendored` installs platform-specific sub-packages
(`exiftool-vendored.pl` for Mac/Linux, `exiftool-vendored.exe` for Windows).
On some systems, optional dependencies are skipped.

Fix:
```bash
# macOS/Linux:
npm install exiftool-vendored.pl --save-optional

# Windows:
npm install exiftool-vendored.exe --save-optional
```

### Issue: App shows "unknown developer" warning on macOS

This is expected in development. During development, right-click → Open to bypass.  
Code signing ($99/year Apple Developer certificate) removes this for distribution.

### Issue: better-sqlite3 fails to build (native module error)

Symptom: Error mentioning `node-gyp` or "was compiled against a different Node.js version".

Fix:
```bash
npx electron-rebuild
```

This rebuilds native modules against the Electron Node.js version.

### Issue: Processing appears frozen on large library

It isn't frozen. ExifTool writing 80,000 photos with GPS data takes 2–4 hours.
The progress bar and ETA estimate show the actual rate.

---

## Development workflow

### Run in development
```bash
npm start
```
Opens the app with DevTools available. Use `Ctrl+Shift+I` (Windows/Linux) or
`Cmd+Option+I` (macOS) to open the renderer DevTools.

### Watch for renderer changes
The renderer (`index.html`, `app.js`) reloads on window focus because Electron
serves the file directly. Edit and switch back to the app window to see changes.
For main process changes, restart with `Ctrl+C` → `npm start`.

### Test the matcher in isolation
```bash
node tests/matcher.test.js
```
Add new test cases when you find new Google filename patterns in real exports.

### Test with a real export
1. Request a small Google Takeout export (Photos only, date-limited to 1 month)
2. Set the size to 2GB max per file
3. Run the app and process it
4. Import the output folder into Apple Photos
5. Verify photos appear in chronological order with correct dates

---

## Building for distribution

### macOS (.dmg)
```bash
npm run make
```
Output: `out/make/Fisssicks-x.x.x.dmg`

Requires: XCode command line tools. Add Apple Developer ID certificate for
distribution without Gatekeeper warnings ($99/year, add after first revenue).

### Windows (.exe installer)
```bash
npm run make
```
Output: `out/make/squirrel.windows/x64/FisssicksSetup.exe`

Must be run on Windows or in a Windows CI environment.  
Windows SmartScreen warnings decrease as download volume builds reputation.

### Both platforms (CI)
Use GitHub Actions with `macos-latest` and `windows-latest` runners.
Add `APPLE_DEVELOPER_ID` and `WINDOWS_CERT` secrets when you have them.

---

## Adding Module 2: Location Timeline map (Sprint 5)

When ready to add the map, these files are the additions:

```
src/processors/locationProcessor.js  ← parse Records.json + semantic monthly files
src/processors/locationWorker.js     ← worker thread for large Records.json
src/renderer/index.html              ← add map tab with Leaflet.js
```

The `detectSchemas()` function already detects `recordsJson` and `semanticDir`.
The `manifest` event from the worker already reports them to the renderer.
Sprint 5 is: wire up the detected paths to a new processor and render the map.

---

## Architecture decisions explained

**Why Worker Threads?**  
`Records.json` can be 500MB+. Parsing it on the main process freezes the UI
entirely — no progress bar, no cancel button, no window drag. Worker Threads
run the parser in a separate V8 isolate. The UI stays responsive.

**Why not Tauri/Rust?**  
Tauri produces a 10MB binary vs Electron's 150MB and is faster for large files.
But it requires learning Rust. Given a 10-week deadline in Node.js, Electron
is correct. Migrate to Tauri if performance becomes a production bottleneck.

**Why no React/Vue?**  
This app has three views and simple state. A framework adds build complexity,
bundle size, and a dependency to maintain. Vanilla JS with direct DOM
manipulation is faster to build and debug for this scope.

**Why Gumroad, not Stripe?**  
Gumroad handles VAT/tax, licence keys, and refunds with zero infrastructure.
At low volume (<1000 sales), Gumroad's 10% fee is cheaper than the developer
time to build a Stripe integration + licence server.

---

## Sidecar matching — how it works

The core algorithm in `src/processors/sidecarMatcher.js` tries four strategies
for each media file, in order:

| # | Strategy | Example |
|---|----------|---------|
| 1 | Old format exact | `IMG_1234.jpg` → `IMG_1234.jpg.json` |
| 2 | New format exact | `IMG_1234.jpg` → `IMG_1234.jpg.supplemental-metadata.json` |
| 3 | Truncated prefix | `PXL_long_name.jpg` → `PXL_long_name.jpg.supplemen...` (first 20 chars match) |
| 4 | Edited/duplicate | `IMG-edited.jpg` → `IMG.json`, `IMG(1).jpg` → `IMG.json` |

If all four fail, `dateFromFilename()` extracts a date from the filename pattern
(PXL\_YYYYMMDD, IMG\_YYYYMMDD, Screenshot\_YYYY-MM-DD, etc.).

If even that fails, the file is logged to the "No Date" category in the results
view so the user can manually handle it.

**Target: >95% match rate on real exports.**  
After Sprint 2, test against a real export and log the match rate. Any new
Google filename patterns found in real exports should be added as test cases
in `tests/matcher.test.js` and handled in `sidecarMatcher.js`.
