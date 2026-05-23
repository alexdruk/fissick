const { _electron: electron } = require('@playwright/test');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..', '..');

async function launchApp() {
  const electronPath = require(path.join(APP_ROOT, 'node_modules', 'electron'));

  const app = await electron.launch({
    executablePath: electronPath,
    args: [path.join(APP_ROOT, 'src/main.js')],
    timeout: 60_000,
    env: { ...process.env, FOSSICK_DEV: '1' },
  });

  // Log any Electron process output so we can see crash reasons
  app.process().stdout?.on('data', d => process.stdout.write('[electron] ' + d));
  app.process().stderr?.on('data', d => process.stderr.write('[electron:err] ' + d));

  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForLoadState('domcontentloaded');

  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => consoleErrors.push(err.message));

  return { app, page, consoleErrors };
}

module.exports = { launchApp, APP_ROOT };
