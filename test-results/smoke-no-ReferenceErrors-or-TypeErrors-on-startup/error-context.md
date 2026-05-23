# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: smoke.spec.js >> no ReferenceErrors or TypeErrors on startup
- Location: tests/smoke.spec.js:22:1

# Error details

```
TimeoutError: electronApplication.firstWindow: Timeout 30000ms exceeded while waiting for event "window"
```

# Test source

```ts
  1  | const { _electron: electron } = require('@playwright/test');
  2  | const path = require('path');
  3  | const fs   = require('fs');
  4  | 
  5  | // Walk up from this file until we find package.json with "electron" in dependencies
  6  | function findProjectRoot() {
  7  |   let dir = __dirname;
  8  |   for (let i = 0; i < 6; i++) {
  9  |     dir = path.dirname(dir);
  10 |     const pkg = path.join(dir, 'package.json');
  11 |     if (fs.existsSync(pkg)) {
  12 |       try {
  13 |         const p = JSON.parse(fs.readFileSync(pkg, 'utf8'));
  14 |         const deps = { ...p.dependencies, ...p.devDependencies };
  15 |         if (deps.electron) return dir;
  16 |       } catch {}
  17 |     }
  18 |   }
  19 |   throw new Error('Could not find Fossick project root (no package.json with electron dep)');
  20 | }
  21 | 
  22 | const APP_ROOT = findProjectRoot();
  23 | 
  24 | async function launchApp() {
  25 |   // Get electron binary path using the project's own electron module
  26 |   const electronModule = path.join(APP_ROOT, 'node_modules', 'electron');
  27 |   const electronPath   = require(electronModule);
  28 | 
  29 |   const app = await electron.launch({
  30 |     executablePath: electronPath,
  31 |     args: [path.join(APP_ROOT, 'src/main.js')],
  32 |     env: {
  33 |       ...process.env,
  34 |       FOSSICK_DEV: '1',
  35 |       NODE_ENV:    'test',
  36 |     },
  37 |   });
  38 | 
> 39 |   const page = await app.firstWindow();
     |                          ^ TimeoutError: electronApplication.firstWindow: Timeout 30000ms exceeded while waiting for event "window"
  40 |   await page.waitForLoadState('domcontentloaded');
  41 | 
  42 |   const consoleErrors = [];
  43 |   page.on('console', msg => {
  44 |     if (msg.type() === 'error') consoleErrors.push(msg.text());
  45 |   });
  46 |   page.on('pageerror', err => consoleErrors.push(err.message));
  47 | 
  48 |   return { app, page, consoleErrors };
  49 | }
  50 | 
  51 | module.exports = { launchApp, APP_ROOT };
  52 | 
```