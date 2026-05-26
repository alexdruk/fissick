# Fissick

**Fix and explore your Google Takeout archive.**

Fissick is a local-first macOS desktop app that repairs broken metadata in Google Takeout photo exports — correct dates and GPS coordinates written back into the actual files, so they import properly into Apple Photos, Lightroom, or any NAS.

Everything runs on your machine. No uploads, no accounts, no subscriptions.

---

## What it fixes

Google Takeout exports your photos but stores the dates and GPS data in separate JSON sidecar files, not in the image EXIF. Most photo apps ignore these sidecars — so your entire library imports with today's date.

Fissick reads every sidecar and writes the correct metadata back into the original files using ExifTool.

It handles the format Google changed in late 2024:

| Old format | New format |
|---|---|
| `IMG_1234.jpg.json` | `IMG_1234.jpg.supplemental-metadata.json` |

Including the 46-character filename truncation that broke most existing tools.

---

## Features

- **Photos** — EXIF repair: dates, GPS, descriptions written to JPG, HEIC, PNG, MP4
- **Map** — interactive map of your Google Timeline location history
- **Places** — automatically detected locations from your photo GPS data
- **Trips** — travel history derived from your archive
- Trial mode: first 1,000 photos free, full archive with a licence

---

## Download

Download the latest DMG from the [Actions tab](https://github.com/alexdruk/fissick/actions) — pick the build matching your Mac:

- **Apple Silicon (M1/M2/M3/M4)** → `Fissick-arm64`
- **Intel Mac** → `Fissick-x64`

> The app is not code-signed. On first launch: **right-click → Open**, then click Open in the dialog.

---

## Development

### Requirements

- Node.js 20+
- macOS (for building DMGs)
- Xcode Command Line Tools (`xcode-select --install`)

### Setup

```bash
git clone https://github.com/alexdruk/fissick.git
cd fissick
npm install
```

### Run in development

```bash
npm start
```

This runs with `FOSSICK_DEV=1` — verbose logging, trial limit still enforced.

### Build DMGs locally

```bash
# Generate icon (one time)
npm run build:icon

# Apple Silicon
npm run build:mac:arm64

# Intel
npm run build:mac:x64

# Both
npm run build:mac
```

DMGs are output to `out/make/`.

---

## Tech stack

| Layer | Library |
|---|---|
| Desktop shell | Electron 31 |
| EXIF writing | exiftool-vendored |
| ZIP extraction | unzipper + system ditto (macOS) |
| Database | better-sqlite3 |
| Maps | Leaflet.js |
| Thumbnails | sharp + sips fallback |

---

## Licence

Private — not open source. Source shared for build purposes only.
