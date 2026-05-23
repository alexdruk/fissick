const { _electron: electron } = require('@playwright/test');
const path = require('path');
const fs   = require('fs');

// Walk up from this file until we find package.json with "electron" in dependencies
function findProjectRoot() {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    dir = path.dirname(dir);
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const p = JSON.parse(fs.readFileSync(pkg, 'utf8'));
        const deps = { ...p.dependencies, ...p.devDependencies };
        if (deps.electron) return dir;
      } catch {}
    }
  }
  throw new Error('Could not find Fossick project root (no package.json with electron dep)');
}

const APP_ROOT = findProjectRoot();

async function launchApp() {
  // Get electron binary path using the project's own electron module
  const electronModule = path.join(APP_ROOT, 'node_modules', 'electron');
  const electronPath   = require(electronModule);

  const app = await electron.launch({
    executablePath: electronPath,
    args: [path.join(APP_ROOT, 'src/main.js')],
    env: {
      ...process.env,
      FOSSICK_DEV: '1',
      NODE_ENV:    'test',
    },
  });

  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => consoleErrors.push(err.message));

  return { app, page, consoleErrors };
}

module.exports = { launchApp, APP_ROOT };
