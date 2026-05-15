// src/processors/exifWriter.js
// Wraps exiftool-vendored for writing metadata to media files.
//
// UTC correctness: Google sidecar timestamps are Unix epoch (UTC).
// ExifTool must receive the date as a UTC-explicit string: "YYYY:MM:DD HH:MM:SS+00:00"
// Using a JS Date object or a local-time string would silently shift times by the
// system timezone offset — corrupting dates for users not in UTC.

'use strict';

const { ExifTool } = require('exiftool-vendored');

let _exiftool = null;

function getExifTool(maxProcs = 4) {
  if (!_exiftool) {
    _exiftool = new ExifTool({ taskTimeoutMillis: 15000, maxProcs });
  }
  return _exiftool;
}

async function shutdownExifTool() {
  if (_exiftool) {
    await _exiftool.end();
    _exiftool = null;
  }
}

// ── UTC date formatter ────────────────────────────────────────────────────────
// Produces "YYYY:MM:DD HH:MM:SS+00:00" — the only format that guarantees
// ExifTool writes the correct absolute time regardless of the user's system clock.

function toUtcExifDate(epochMs) {
  const d = new Date(epochMs);
  const pad = n => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}:${pad(d.getUTCMonth() + 1)}:${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+00:00`
  );
}

// ── Write from sidecar ────────────────────────────────────────────────────────

async function writeExifFromSidecar(mediaPath, sidecar, procs = 4) {
  const et = getExifTool(procs);

  try {
    const rawTs = sidecar.photoTakenTime?.timestamp;
    if (!rawTs) return { written: false, error: 'No timestamp in sidecar' };

    const ts = parseInt(rawTs, 10);
    if (!ts || ts <= 0) return { written: false, error: `Invalid timestamp: ${rawTs}` };

    const epochMs   = ts * 1000;
    const exifDate  = toUtcExifDate(epochMs);

    const tags = {
      DateTimeOriginal: exifDate,
      CreateDate:       exifDate,
    };

    // GPS — only write when non-zero (Google stores 0,0 for no location)
    const geo = sidecar.geoData || sidecar.geoDataExif;
    if (geo && (Math.abs(geo.latitude) > 0.0001 || Math.abs(geo.longitude) > 0.0001)) {
      tags.GPSLatitude     = Math.abs(geo.latitude);
      tags.GPSLatitudeRef  = geo.latitude  >= 0 ? 'N' : 'S';
      tags.GPSLongitude    = Math.abs(geo.longitude);
      tags.GPSLongitudeRef = geo.longitude >= 0 ? 'E' : 'W';
      if (geo.altitude != null) {
        tags.GPSAltitude    = Math.abs(geo.altitude);
        tags.GPSAltitudeRef = geo.altitude >= 0 ? 0 : 1;
      }
    }

    if (sidecar.description?.trim()) {
      tags.ImageDescription = sidecar.description.trim();
    }

    await et.write(mediaPath, tags, ['-overwrite_original', '-preserve']);
    return { written: true, error: null };

  } catch (err) {
    return { written: false, error: err.message };
  }
}

// ── Write date only (filename fallback) ───────────────────────────────────────

async function writeExifDate(mediaPath, epochMs, procs = 4) {
  const et = getExifTool(procs);
  try {
    const exifDate = toUtcExifDate(epochMs);
    await et.write(mediaPath, {
      DateTimeOriginal: exifDate,
      CreateDate:       exifDate,
    }, ['-overwrite_original', '-preserve']);
    return { written: true, error: null };
  } catch (err) {
    return { written: false, error: err.message };
  }
}

module.exports = { writeExifFromSidecar, writeExifDate, shutdownExifTool };
