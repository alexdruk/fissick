# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: smoke.spec.js >> Your Archive section is hidden on import page
- Location: tests/smoke.spec.js:66:1

# Error details

```
Error: expect(locator).toBeHidden() failed

Locator:  locator('#sb-archive')
Expected: hidden
Received: visible
Timeout:  5000ms

Call log:
  - Expect "toBeHidden" with timeout 5000ms
  - waiting for locator('#sb-archive')
    14 × locator resolved to <div id="sb-archive">…</div>
       - unexpected value "visible"

```

```yaml
- text: Your Archive 📷 Photos & Videos 🌍 Trips 📚 Albums 📍 Places
```

# Test source

```ts
  1   | // tests/smoke.spec.js
  2   | // Fossick smoke tests — covers the bugs we've actually shipped.
  3   | // Run: npx playwright test tests/smoke.spec.js
  4   | 
  5   | const { test, expect } = require('@playwright/test');
  6   | const { launchApp }    = require('./helpers/electron');
  7   | 
  8   | // ── Setup: one app instance per suite ────────────────────────────────────────
  9   | let app, page, consoleErrors;
  10  | 
  11  | test.beforeAll(async () => {
  12  |   ({ app, page, consoleErrors } = await launchApp());
  13  |   // Give app 3s to fully boot
  14  |   await page.waitForTimeout(3000);
  15  | });
  16  | 
  17  | test.afterAll(async () => {
  18  |   if (app) await app.close();
  19  | });
  20  | 
  21  | // ── 1. No fatal JS errors on startup ─────────────────────────────────────────
  22  | test('no ReferenceErrors or TypeErrors on startup', async () => {
  23  |   const fatal = consoleErrors.filter(e =>
  24  |     e.includes('ReferenceError') || e.includes('TypeError: Cannot read')
  25  |   );
  26  |   expect(fatal, `Fatal JS errors:\n${fatal.join('\n')}`).toHaveLength(0);
  27  | });
  28  | 
  29  | // ── 2. Import page loads correctly ───────────────────────────────────────────
  30  | test('import page shows correct content', async () => {
  31  |   // Eyebrow bar
  32  |   await expect(page.locator('.import-eyebrow-bar')).toBeVisible();
  33  |   await expect(page.locator('.import-eyebrow-bar')).toContainText('FOSSICK');
  34  | 
  35  |   // Headline
  36  |   await expect(page.locator('.import-title')).toBeVisible();
  37  |   await expect(page.locator('.import-title')).toContainText('Google Takeout');
  38  | 
  39  |   // Both source buttons present
  40  |   await expect(page.locator('#btn-select-zips')).toBeVisible();
  41  |   await expect(page.locator('#btn-select-folder')).toBeVisible();
  42  | 
  43  |   // Process button hidden until source is selected
  44  |   await expect(page.locator('#btn-start')).toBeHidden();
  45  | });
  46  | 
  47  | // ── 3. Feature pills all render ───────────────────────────────────────────────
  48  | test('feature pills are all visible', async () => {
  49  |   const pills = page.locator('.import-feat');
  50  |   const count = await pills.count();
  51  |   expect(count, 'Expected at least 4 feature pills').toBeGreaterThanOrEqual(4);
  52  |   // Must NOT contain 100% local (was removed)
  53  |   const texts = await pills.allTextContents();
  54  |   const has100Local = texts.some(t => t.includes('100% local'));
  55  |   expect(has100Local, '"100% local" pill should have been removed').toBe(false);
  56  | });
  57  | 
  58  | // ── 4. Sidebar workflow items present ─────────────────────────────────────────
  59  | test('sidebar has Import, Process, Results workflow items', async () => {
  60  |   await expect(page.locator('#sb-import')).toBeVisible();
  61  |   await expect(page.locator('#sb-process')).toBeVisible();
  62  |   await expect(page.locator('#sb-results')).toBeVisible();
  63  | });
  64  | 
  65  | // ── 5. Your Archive section hidden on import page ─────────────────────────────
  66  | test('Your Archive section is hidden on import page', async () => {
> 67  |   await expect(page.locator('#sb-archive')).toBeHidden();
      |                                             ^ Error: expect(locator).toBeHidden() failed
  68  | });
  69  | 
  70  | // ── 6. Results click works (navigates away from import) ───────────────────────
  71  | test('clicking Results navigates to results view', async () => {
  72  |   // Click Results in sidebar
  73  |   await page.locator('#sb-results').click();
  74  |   await page.waitForTimeout(2000);
  75  | 
  76  |   // Should no longer be on import view
  77  |   const importView = page.locator('#view-import');
  78  |   const isImportActive = await importView.evaluate(el => el.classList.contains('active'));
  79  | 
  80  |   // Check for the fatal errors that caused this bug before
  81  |   const licenceErrors = consoleErrors.filter(e =>
  82  |     e.includes('refreshLicenceStatus') || e.includes('licenceStatus')
  83  |   );
  84  |   expect(licenceErrors, `Licence errors:\n${licenceErrors.join('\n')}`).toHaveLength(0);
  85  | 
  86  |   // Navigate back to import for next tests
  87  |   await page.locator('#sb-import').click();
  88  |   await page.waitForTimeout(500);
  89  | });
  90  | 
  91  | // ── 7. No doubled file markers in rendered JS ─────────────────────────────────
  92  | test('app.js has no duplicate function declarations', async () => {
  93  |   // Evaluate in page context — check that key functions exist exactly once
  94  |   const counts = await page.evaluate(() => {
  95  |     // We can't grep the source, but we can check that globals exist and are functions
  96  |     return {
  97  |       hasRefreshLicence: typeof refreshLicenceStatus !== 'undefined',
  98  |       hasLoadResults:    typeof loadResults           !== 'undefined',
  99  |       hasShowView:       typeof showView              !== 'undefined',
  100 |       hasOpenLightbox:   typeof openLightbox          !== 'undefined',
  101 |       hasInit:           typeof init                  !== 'undefined',
  102 |     };
  103 |   });
  104 |   expect(counts.hasRefreshLicence, 'refreshLicenceStatus missing').toBe(true);
  105 |   expect(counts.hasLoadResults,    'loadResults missing').toBe(true);
  106 |   expect(counts.hasShowView,       'showView missing').toBe(true);
  107 |   expect(counts.hasOpenLightbox,   'openLightbox missing').toBe(true);
  108 | });
  109 | 
  110 | // ── 8. Lightbox nav buttons exist ────────────────────────────────────────────
  111 | test('lightbox has prev/next navigation buttons', async () => {
  112 |   await expect(page.locator('#lightbox-prev')).toBeAttached();
  113 |   await expect(page.locator('#lightbox-next')).toBeAttached();
  114 | });
  115 | 
  116 | // ── 9. Export buttons exist and are in correct initial state ─────────────────
  117 | test('export buttons are present', async () => {
  118 |   // Navigate to results first
  119 |   await page.locator('#sb-results').click();
  120 |   await page.waitForTimeout(2000);
  121 | 
  122 |   // These should always exist in the DOM
  123 |   await expect(page.locator('#btn-export-csv')).toBeAttached();
  124 |   await expect(page.locator('#btn-export-copy')).toBeAttached();
  125 |   await expect(page.locator('#btn-export-by-date')).toBeAttached();
  126 | 
  127 |   // Export by trip should NOT exist (was removed)
  128 |   await expect(page.locator('#btn-export-by-trip')).not.toBeAttached();
  129 | 
  130 |   // Back to import
  131 |   await page.locator('#sb-import').click();
  132 |   await page.waitForTimeout(500);
  133 | });
  134 | 
  135 | // ── 10. No TripMaps.observe calls (removed dead code) ────────────────────────
  136 | test('TripMaps.observe is not called (dead code removed)', async () => {
  137 |   const tripMapsObserveErrors = consoleErrors.filter(e =>
  138 |     e.includes('TripMaps.observe') || e.includes('observe is not a function')
  139 |   );
  140 |   expect(tripMapsObserveErrors).toHaveLength(0);
  141 | });
  142 | 
  143 | // ── 11. Places search input exists ───────────────────────────────────────────
  144 | test('places search input is in the DOM', async () => {
  145 |   await expect(page.locator('#places-search')).toBeAttached();
  146 |   await expect(page.locator('#places-search-clear')).toBeAttached();
  147 | });
  148 | 
  149 | // ── 12. Resume banner hidden on fresh start ───────────────────────────────────
  150 | test('resume banner is hidden when no incomplete run exists', async () => {
  151 |   // Resume banner should only show if run_state is in the DB
  152 |   // On a fresh test run it should be hidden
  153 |   await expect(page.locator('#resume-banner')).not.toHaveClass(/visible/);
  154 | });
  155 | 
  156 | // ── 13. No console errors accumulated ────────────────────────────────────────
  157 | test('no console errors accumulated during test run', async () => {
  158 |   // Filter out known benign warnings
  159 |   const realErrors = consoleErrors.filter(e =>
  160 |     !e.includes('local-reverse-geocoder') &&  // geocoder init warning is benign
  161 |     !e.includes('ExifTool') &&                // ExifTool not running in test mode
  162 |     !e.includes('net::ERR_FILE_NOT_FOUND')    // missing thumbnails in test mode
  163 |   );
  164 |   if (realErrors.length > 0) {
  165 |     console.log('Console errors found:\n', realErrors.join('\n'));
  166 |   }
  167 |   expect(realErrors).toHaveLength(0);
```