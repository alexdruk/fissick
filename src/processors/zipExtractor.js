// src/processors/zipExtractor.js
// Streaming ZIP extraction.
// On macOS: uses the system /usr/bin/unzip — handles every zip Finder creates.
// On Windows: uses the unzipper npm package.
// Never loads the full archive into RAM.

const fs           = require('fs');
const path         = require('path');
const { execFile } = require('child_process');

const devMode = process.env.FOSSICK_DEV === '1';
const log = (...a) => { if (devMode) console.log(...a); };

/**
 * Extract one or more Takeout ZIP files to a single destination directory.
 *
 * @param {string[]} zipPaths   - Ordered array of ZIP file paths
 * @param {string}   destDir    - Output directory (created if it doesn't exist)
 * @param {Function} onProgress - Called with { file: string, extracted: number }
 * @returns {Promise<string>}   - Resolves to destDir when complete
 */
async function extractZips(zipPaths, destDir, onProgress) {
  fs.mkdirSync(destDir, { recursive: true });

  let totalExtracted = 0;

  for (const zipPath of zipPaths) {
    const zipSize = fs.statSync(zipPath).size;
    log(`[zipExtractor] ${path.basename(zipPath)} — ${(zipSize / 1024).toFixed(1)} KB`);

    if (process.platform === 'darwin' || process.platform === 'linux') {
      await extractWithSystemUnzip(zipPath, destDir, (count) => {
        totalExtracted = count;
        if (onProgress) onProgress({ file: null, extracted: totalExtracted });
      });
    } else {
      await extractWithUnzipper(zipPath, destDir, (entryPath) => {
        totalExtracted++;
        if (onProgress && totalExtracted % 50 === 0) {
          onProgress({ file: entryPath, extracted: totalExtracted });
        }
      });
    }
  }

  if (onProgress) onProgress({ file: null, extracted: totalExtracted });
  return destDir;
}

/**
 * macOS / Linux: shell out to /usr/bin/unzip.
 * -o  overwrite without prompting
 * -q  quiet (no per-file output to stdout)
 */
function extractWithSystemUnzip(zipPath, destDir, onDone) {
  return new Promise((resolve) => {
    const useDitto = process.platform === 'darwin';

    // Track entry count from unzip stdout (-v flag) or accept an estimate.
    // We no longer recursively re-scan destDir after each ZIP — that was O(n²)
    // on multi-part archives. Progress is best-effort for display only.
    let zipEntryCount = 0;
    const done = (count) => {
      zipEntryCount = count || zipEntryCount;
      log(`[zipExtractor] ${path.basename(zipPath)}: ~${zipEntryCount} entries extracted.`);
      onDone(zipEntryCount);
      resolve(); // always resolve — never reject, never stop the queue
    };

    if (useDitto) {
      // ditto doesn't report counts — run a quick top-level count via unzip -Z1
      execFile('/usr/bin/unzip', ['-Z1', zipPath], (e, stdout) => {
        const estimate = stdout ? stdout.trim().split('\n').length : 0;
        execFile('/usr/bin/ditto', ['-xk', zipPath, destDir], (err, _out, stderr) => {
          if (err) console.warn(`[zipExtractor] ditto warning on ${path.basename(zipPath)}:`, stderr || err.message);
          done(estimate);
        });
      });
    } else {
      execFile('unzip', ['-o', '-q', zipPath, '-d', destDir], (err, stdout, stderr) => {
        if (err && err.code > 1) console.warn(`[zipExtractor] unzip warning on ${path.basename(zipPath)}:`, stderr || err.message);
        done(0);
      });
    }
  });
}

/**
 * Windows fallback: use unzipper npm package.
 */
async function extractWithUnzipper(zipPath, destDir, onEntry) {
  const unzipper = require('unzipper');

  return new Promise((resolve, reject) => {
    let entryCount = 0;
    const pending  = [];

    const stream = fs.createReadStream(zipPath)
      .pipe(unzipper.Parse({ forceStream: true }));

    stream.on('entry', (entry) => {
      entryCount++;
      const entryPath = entry.path;
      const type      = entry.type;

      if (
        entryPath.startsWith('__MACOSX') ||
        path.basename(entryPath) === '.DS_Store' ||
        path.basename(entryPath).startsWith('._')
      ) {
        entry.autodrain();
        return;
      }

      // ZIP Slip guard: reject any entry that would escape the destination dir
      const destPath = path.resolve(destDir, entryPath);
      if (!destPath.startsWith(path.resolve(destDir) + path.sep) &&
          destPath !== path.resolve(destDir)) {
        console.warn(`[zipExtractor] ZIP Slip rejected: ${entryPath}`);
        entry.autodrain();
        return;
      }

      if (type === 'Directory') {
        fs.mkdirSync(destPath, { recursive: true });
        entry.autodrain();
      } else {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });

        const p = new Promise((res, rej) => {
          entry.pipe(fs.createWriteStream(destPath))
            .on('finish', () => { onEntry(entryPath); res(); })
            .on('error', rej);
          entry.on('error', rej);
        });
        pending.push(p);
      }
    });

    stream.on('finish', async () => {
      log(`[zipExtractor] unzipper: ${entryCount} entries, ${pending.length} file writes`);
      try { await Promise.all(pending); resolve(); }
      catch (err) { reject(err); }
    });

    stream.on('error', reject);
  });
}

module.exports = { extractZips };

// src/processors/zipExtractor.js
// Streaming ZIP extraction.
// On macOS: uses the system /usr/bin/unzip — handles every zip Finder creates.
// On Windows: uses the unzipper npm package.
// Never loads the full archive into RAM.

