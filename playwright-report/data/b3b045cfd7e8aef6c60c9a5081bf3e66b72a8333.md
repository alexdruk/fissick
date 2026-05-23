# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: smoke.spec.js >> no ReferenceErrors or TypeErrors on startup
- Location: tests/smoke.spec.js:22:1

# Error details

```
Error: electron.launch: 
╔══════════════════════════════════════════════════════════════════════════════════════════════════════════╗
║ Electron executablePath not found!                                                                       ║
║ Please install it using `npm install -D electron` or set the executablePath to your Electron executable. ║
╚══════════════════════════════════════════════════════════════════════════════════════════════════════════╝
```

# Test source

```ts
  1  | const { _electron: electron } = require('@playwright/test');
  2  | const path = require('path');
  3  | 
  4  | // Fossick project root — adjust this if tests live elsewhere
  5  | const APP_ROOT = path.resolve(__dirname, '../../..');
  6  | 
  7  | async function launchApp() {
> 8  |   const app = await electron.launch({
     |               ^ Error: electron.launch: 
  9  |     args: [path.join(APP_ROOT, 'src/main.js')],
  10 |     env: {
  11 |       ...process.env,
  12 |       FOSSICK_DEV: '1',
  13 |       NODE_ENV: 'test',
  14 |     },
  15 |   });
  16 | 
  17 |   const page = await app.firstWindow();
  18 |   await page.waitForLoadState('domcontentloaded');
  19 | 
  20 |   const consoleErrors = [];
  21 |   page.on('console', msg => {
  22 |     if (msg.type() === 'error') consoleErrors.push(msg.text());
  23 |   });
  24 |   page.on('pageerror', err => consoleErrors.push(err.message));
  25 | 
  26 |   return { app, page, consoleErrors };
  27 | }
  28 | 
  29 | module.exports = { launchApp, APP_ROOT };
  30 | 
```