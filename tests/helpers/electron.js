const { _electron: electron } = require('@playwright/test');
const path = require('path');

// Fossick project root — adjust this if tests live elsewhere
const APP_ROOT = path.resolve(__dirname, '../../..');

async function launchApp() {
  const app = await electron.launch({
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
