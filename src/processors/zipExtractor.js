// src/processors/zipExtractor.js
// Streaming ZIP extraction.
// On macOS: uses the system /usr/bin/unzip — handles every zip Finder creates.
// On Windows: uses the unzipper npm package.
// Never loads the full archive into RAM.

const fs           = require('fs');
const path         = require('path');
const { execFile } = require('child_process');

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
    console.log(`[zipExtractor] ${path.basename(zipPath)} — ${(zipSize / 1024).toFixed(1)} KB`);

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

    const done = () => {
      let count = 0;
      const countFiles = (dir) => {
        try {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) countFiles(path.join(dir, entry.name));
            else count++;
          }
        } catch {}
      };
      countFiles(destDir);
      console.log(`[zipExtractor] ${path.basename(zipPath)}: extracted ${count} files.`);
      onDone(count);
      resolve(); // always resolve — never reject, never stop the queue
    };

    if (useDitto) {
      execFile('/usr/bin/ditto', ['-xk', zipPath, destDir], (err, stdout, stderr) => {
        if (err) console.warn(`[zipExtractor] ditto warning on ${path.basename(zipPath)}:`, stderr || err.message);
        done();
      });
    } else {
      execFile('unzip', ['-o', '-q', zipPath, '-d', destDir], (err, stdout, stderr) => {
        if (err && err.code > 1) console.warn(`[zipExtractor] unzip warning on ${path.basename(zipPath)}:`, stderr || err.message);
        done();
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

      const destPath = path.join(destDir, entryPath);

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
      console.log(`[zipExtractor] unzipper: ${entryCount} entries, ${pending.length} file writes`);
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

const fs           = require('fs');
const path         = require('path');
const { execFile } = require('child_process');

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
    console.log(`[zipExtractor] ${path.basename(zipPath)} — ${(zipSize / 1024).toFixed(1)} KB`);

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

    const done = () => {
      let count = 0;
      const countFiles = (dir) => {
        try {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) countFiles(path.join(dir, entry.name));
            else count++;
          }
        } catch {}
      };
      countFiles(destDir);
      console.log(`[zipExtractor] ${path.basename(zipPath)}: extracted ${count} files.`);
      onDone(count);
      resolve(); // always resolve — never reject, never stop the queue
    };

    if (useDitto) {
      execFile('/usr/bin/ditto', ['-xk', zipPath, destDir], (err, stdout, stderr) => {
        if (err) console.warn(`[zipExtractor] ditto warning on ${path.basename(zipPath)}:`, stderr || err.message);
        done();
      });
    } else {
      execFile('unzip', ['-o', '-q', zipPath, '-d', destDir], (err, stdout, stderr) => {
        if (err && err.code > 1) console.warn(`[zipExtractor] unzip warning on ${path.basename(zipPath)}:`, stderr || err.message);
        done();
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

      const destPath = path.join(destDir, entryPath);

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
      console.log(`[zipExtractor] unzipper: ${entryCount} entries, ${pending.length} file writes`);
      try { await Promise.all(pending); resolve(); }
      catch (err) { reject(err); }
    });

    stream.on('error', reject);
  });
}

module.exports = { extractZips };

