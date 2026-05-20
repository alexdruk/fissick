const { spawnSync } = require('child_process');
const chokidar = require('chokidar');

const watchPaths = ['src/**', 'tests/**', 'forge.config.js', 'package.json'];
const ignorePatterns = ['node_modules/**', '.git/**', 'out/**', '*.db'];
const debounceMs = 2000;
let timer = null;
let lastEvent = null;

function log(message) {
  process.stdout.write(`${new Date().toISOString()} - ${message}\n`);
}

function runGitCommand(args) {
  const result = spawnSync('git', args, { stdio: 'pipe', encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function buildCommitMessage(diffOutput) {
  const lines = diffOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const changes = lines.map((line) => {
    const parts = line.split('\t');
    const status = parts[0];
    if (status.startsWith('R')) {
      return {
        verb: 'rename',
        path: `${parts[1]} -> ${parts[2]}`,
      };
    }

    const path = parts[1] || parts[0];
    switch (status) {
      case 'A':
        return { verb: 'add', path };
      case 'M':
        return { verb: 'update', path };
      case 'D':
        return { verb: 'delete', path };
      case 'C':
        return { verb: 'copy', path };
      default:
        return { verb: 'modify', path };
    }
  });

  if (!changes.length) {
    return `Auto-commit: ${new Date().toISOString()}`;
  }

  const summary = changes.map((c) => `${c.verb} ${c.path}`);
  if (summary.length === 1) {
    return `Auto-commit: ${summary[0]}`;
  }

  if (summary.length <= 3) {
    return `Auto-commit: ${summary.join(', ')}`;
  }

  return `Auto-commit: ${summary[0]}, ${summary[1]}, +${summary.length - 2} more`;
}

function commitPendingChanges() {
  log(`Processing change event: ${lastEvent}`);

  const addResult = runGitCommand(['add', '-A']);
  if (addResult.status !== 0) {
    log(`git add failed: ${addResult.stderr || addResult.stdout}`);
    return;
  }

  const diffResult = runGitCommand(['diff', '--cached', '--quiet']);
  if (diffResult.status === 0) {
    log('No staged changes detected, skipping commit.');
    return;
  }

  const nameStatus = runGitCommand(['diff', '--cached', '--name-status', '-M']);
  const message = buildCommitMessage(nameStatus.stdout);
  const commitResult = runGitCommand(['commit', '-m', message]);
  if (commitResult.status !== 0) {
    log(`git commit failed: ${commitResult.stderr || commitResult.stdout}`);
  } else {
    log(`Committed changes: ${message}`);
    // Optional push to remote when AUTO_PUSH env var is set
    const autoPush = (process.env.AUTO_PUSH || process.env.AUTOPUSH || '').toLowerCase();
    if (autoPush === '1' || autoPush === 'true' || autoPush === 'yes') {
      log('AUTO_PUSH enabled — pushing to remote...');
      const pushResult = runGitCommand(['push']);
      if (pushResult.status !== 0) {
        log(`git push failed: ${pushResult.stderr || pushResult.stdout}`);
      } else {
        log(`Pushed to remote: ${pushResult.stdout || 'success'}`);
      }
    }
  }
}

function scheduleCommit(event, path) {
  lastEvent = `${event}:${path}`;
  if (timer) {
    clearTimeout(timer);
  }
  timer = setTimeout(commitPendingChanges, debounceMs);
}

const watcher = chokidar.watch(watchPaths, {
  ignored: ignorePatterns,
  ignoreInitial: true,
  persistent: true,
});

watcher.on('all', (event, path) => {
  log(`File change detected: ${event} ${path}`);
  scheduleCommit(event, path);
});

watcher.on('ready', () => {
  log('Autocommit watcher ready.');
});

watcher.on('error', (error) => {
  log(`Watcher error: ${error}`);
});

log('Autocommit watcher started, waiting for ready state...');

process.on('SIGINT', () => {
  log('Stopping autocommit watcher.');
  watcher.close().then(() => process.exit(0));
});

