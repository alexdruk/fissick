const { _electron: electron } = require('@playwright/test');
const path = require('path');

// Fossick project root
const APP_ROOT = path.resolve(__dirname, '../../..');

async function launchApp() {
  // Find Electron binary from the app's own node_modules
  const electronPath = require(path.join(APP_ROOT, 'node_modules/electron'));

  const app = await electron.launch({
    executablePath: electronPath,
    args: [path.join(APP_ROOT, 'src/main.js')],
    env: {
      ...process.env,
      FOSSICK_DEV: '1',
      NODE_ENV: 'test',
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
