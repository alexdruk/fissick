# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: smoke.spec.js >> import page shows correct content
- Location: tests/smoke.spec.js:30:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('.import-eyebrow-bar')
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for locator('.import-eyebrow-bar')

```

```yaml
- text: Fissick.
- button "Help"
- text: Workflow 📦 Import ⚙️ Process ✅ Results Your Archive 📷 Photos & Videos 🌍 Trips 📚 Albums 📍 Places Last archive Total 33,048 Fixed 32,213 No sidecar 235 With GPS 21,572 Locations — Trips 318 Albums 199 Places 360
- button "Import Setting"
- button "⚙"
- text: "Turn your Google Takeout into a personal archive. Fossick repairs every broken photo date and GPS coordinate — including Google’s 2024 format change that broke everything else. Then gives you a living archive: an interactive location map, automatically detected trips, your albums, and your most-visited places. Nothing leaves your machine. 📷 EXIF repair 🗺 Location map ✈️ Trips 📚 Albums 📍 Places I have ZIP files"
- button "🗜️ Select ZIP files takeout-…-001.zip, -002.zip, etc.":
  - text: 🗜️
  - strong: Select ZIP files
  - text: takeout-…-001.zip, -002.zip, etc.
- text: Photos & Videos 33,048 photos · 32,213 EXIF fixed 32,213 EXIF fixed (97%) 33,048 total photos 235 no sidecar 21,572 with GPS 2000–2026 date range Export
- button "📋 Photos CSV" [disabled]
- button "📂 Copy Fixed Files" [disabled]
- button "📅 Export by Date"
- text: All EXIF Fixed No Sidecar No Date Has GPS
- combobox:
  - option "All types" [selected]
  - option "JPG (19,814)"
  - option "HEIC (11,988)"
  - option "MOV (793)"
  - option "MP4 (287)"
  - option "JPEG (118)"
  - option "PNG (47)"
  - option "GIF (1)"
- text: 🌍 Trips 📚 Albums 📍 Places Date range
- combobox:
  - option "Year"
  - option "2000" [selected]
  - option "2001"
  - option "2002"
  - option "2003"
  - option "2004"
  - option "2005"
  - option "2006"
  - option "2007"
  - option "2008"
  - option "2009"
  - option "2010"
  - option "2011"
  - option "2012"
  - option "2013"
  - option "2014"
  - option "2015"
  - option "2016"
  - option "2017"
  - option "2018"
  - option "2019"
  - option "2020"
  - option "2021"
  - option "2022"
  - option "2023"
  - option "2024"
  - option "2025"
  - option "2026"
- combobox:
  - option "Month" [selected]
  - option "Jan"
  - option "Feb"
  - option "Mar"
  - option "Apr"
  - option "May"
  - option "Jun"
  - option "Jul"
  - option "Aug"
  - option "Sep"
  - option "Oct"
  - option "Nov"
  - option "Dec"
- combobox:
  - option "Day" [selected]
- text: →
- combobox:
  - option "Year"
  - option "2000"
  - option "2001"
  - option "2002"
  - option "2003"
  - option "2004"
  - option "2005"
  - option "2006"
  - option "2007"
  - option "2008"
  - option "2009"
  - option "2010"
  - option "2011"
  - option "2012"
  - option "2013"
  - option "2014"
  - option "2015"
  - option "2016"
  - option "2017"
  - option "2018"
  - option "2019"
  - option "2020"
  - option "2021"
  - option "2022"
  - option "2023"
  - option "2024"
  - option "2025"
  - option "2026" [selected]
- combobox:
  - option "Month" [selected]
  - option "Jan"
  - option "Feb"
  - option "Mar"
  - option "Apr"
  - option "May"
  - option "Jun"
  - option "Jul"
  - option "Aug"
  - option "Sep"
  - option "Oct"
  - option "Nov"
  - option "Dec"
- combobox:
  - option "Day" [selected]
- button "Apply"
- checkbox "Select all"
- text: 0 selected
- checkbox
- text: Jan 30, 2000 DSCF0456.JPG EXIF fixed sidecar
- checkbox
- text: Mar 18, 2000 Yasha1.JPG EXIF fixed sidecar
- checkbox
- text: Jul 19, 2000 sasha i Vova 2.jpg EXIF fixed sidecar
- checkbox
- text: Dec 30, 2000 Sanya1.JPG EXIF fixed sidecar
- checkbox
- text: May 9, 2001 P1010023.JPG EXIF fixed sidecar
- checkbox
- text: Mar 4, 2002 Pahota2.JPG EXIF fixed sidecar
- checkbox
- text: Jun 22, 2002 P6220114.JPG EXIF fixed sidecar
- checkbox
- text: Jun 23, 2002 P6220128.JPG EXIF fixed sidecar
- checkbox
- text: Jun 23, 2002 P6220129.JPG EXIF fixed sidecar
- checkbox
- text: Jun 23, 2002 P6220131.JPG EXIF fixed sidecar
- checkbox
- text: Jun 23, 2002 P6220143.JPG EXIF fixed sidecar
- checkbox
- text: Feb 17, 2003 S drovami 2.jpg EXIF fixed sidecar
- checkbox
- text: Mar 16, 2003 IMG_1713.JPG EXIF fixed sidecar
- checkbox
- text: Mar 16, 2003 IMG_1715.JPG EXIF fixed sidecar
- checkbox
- text: Mar 16, 2003 IMG_1728.JPG EXIF fixed sidecar
- checkbox
- text: Mar 16, 2003 IMG_1730.JPG EXIF fixed sidecar
- checkbox
- text: Mar 16, 2003 IMG_1731.JPG EXIF fixed sidecar
- checkbox
- text: Mar 16, 2003 IMG_1733.JPG EXIF fixed sidecar
- checkbox
- text: Mar 17, 2003 IMG_1714.JPG EXIF fixed sidecar
- checkbox
- text: Mar 17, 2003 IMG_1721.JPG EXIF fixed sidecar
- checkbox
- text: Oct 11, 2004 LINDA copy.JPG EXIF fixed sidecar
- checkbox
- text: Oct 11, 2004 LINDA.JPG EXIF fixed sidecar
- checkbox
- text: Oct 12, 2004 Linda003.jpg EXIF fixed sidecar
- checkbox
- text: Nov 21, 2004 Linda005 copy.jpg EXIF fixed sidecar
- checkbox
- text: Nov 21, 2004 Linda005.jpg EXIF fixed sidecar
- checkbox
- text: Nov 21, 2004 Linda020 copy.jpg EXIF fixed sidecar
- checkbox
- text: Nov 21, 2004 Linda020.jpg EXIF fixed sidecar
- checkbox
- text: May 8, 2006 IMG_8803.JPG EXIF fixed sidecar
- checkbox
- text: May 8, 2006 IMG_8797.JPG EXIF fixed sidecar
- checkbox
- text: May 8, 2006 IMG_8799.JPG EXIF fixed sidecar
- checkbox
- text: Sep 23, 2006 Nash dom.jpg EXIF fixed sidecar
- checkbox
- text: Sep 23, 2006 Manin dom.jpg EXIF fixed sidecar
- checkbox
- text: Sep 23, 2006 Anrei.jpg EXIF fixed sidecar
- checkbox
- text: Sep 23, 2006 Sania i Mania.jpg EXIF fixed sidecar
- checkbox
- text: Sep 23, 2006 100_1392.jpg EXIF fixed sidecar
- checkbox
- text: Sep 23, 2006 Mane 17.jpg EXIF fixed sidecar
- checkbox
- text: Sep 23, 2006 Mani 1.jpg EXIF fixed sidecar
- checkbox
- text: Sep 24, 2006 Rest Stop 2.jpg EXIF fixed sidecar
- checkbox
- text: Sep 24, 2006 Rest stop 1.JPG EXIF fixed sidecar
- checkbox
- text: Sep 24, 2006 Ya i Agi - po doroge v Boston.jpg EXIF fixed sidecar
- checkbox
- text: Sep 24, 2006 Zakovali 2.jpg EXIF fixed sidecar
- checkbox
- text: Sep 24, 2006 Zakovali 1.JPG EXIF fixed sidecar
- checkbox
- text: Sep 24, 2006 Mani i papa.JPG EXIF fixed sidecar
- checkbox
- text: Sep 24, 2006 DSC05440.JPG EXIF fixed sidecar
- checkbox
- text: Sep 24, 2006 DSC05441.JPG EXIF fixed sidecar
- checkbox
- text: Sep 24, 2006 DSC05442.JPG EXIF fixed sidecar
- checkbox
- text: Sep 24, 2006 DSC05445.JPG EXIF fixed sidecar
- checkbox
- text: Sep 24, 2006 Sbor yablok 1.jpg EXIF fixed sidecar
- checkbox
- text: Sep 24, 2006 Sbor yablok2.jpg EXIF fixed sidecar
- checkbox
- text: Sep 24, 2006 Mania1.jpg EXIF fixed sidecar
- checkbox
- text: Sep 24, 2006 DSC05453.JPG EXIF fixed sidecar
- checkbox
- text: Sep 25, 2006 DSC05484.JPG EXIF fixed sidecar
- checkbox
- text: Sep 25, 2006 DSC05488.JPG EXIF fixed sidecar
- checkbox
- text: Sep 25, 2006 DSC05510.JPG EXIF fixed sidecar
- checkbox
- text: Sep 25, 2006 DSC05512.JPG EXIF fixed sidecar
- checkbox
- text: Sep 25, 2006 DSC05518.JPG EXIF fixed sidecar
- checkbox
- text: Sep 25, 2006 DSC05519.JPG EXIF fixed sidecar
- checkbox
- text: Sep 25, 2006 DSC05526-edited.JPG EXIF fixed sidecar
- checkbox
- text: Sep 25, 2006 DSC05526.JPG EXIF fixed sidecar
- checkbox
- text: Sep 25, 2006 Berkovichi.JPG EXIF fixed sidecar Showing 60 of 33,048
- button "Load more"
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
> 32  |   await expect(page.locator('.import-eyebrow-bar')).toBeVisible();
      |                                                     ^ Error: expect(locator).toBeVisible() failed
  33  |   await expect(page.locator('.import-eyebrow-bar')).toContainText('Fossick');
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
  65  | // ── 5. Your Archive section exists in sidebar ─────────────────────────────────
  66  | // It shows when DB has data (existing archive), hides when fresh.
  67  | // Both states are valid — just verify the element exists.
  68  | test('Your Archive section exists in sidebar', async () => {
  69  |   await expect(page.locator('#sb-archive')).toBeAttached();
  70  |   // Verify it contains the expected archive items
  71  |   await expect(page.locator('#sb-photos')).toBeAttached();
  72  |   await expect(page.locator('#sb-albums')).toBeAttached();
  73  |   await expect(page.locator('#sb-places')).toBeAttached();
  74  | });
  75  | 
  76  | // ── 6. Results click works (navigates away from import) ───────────────────────
  77  | test('clicking Results navigates to results view', async () => {
  78  |   // Click Results in sidebar
  79  |   await page.locator('#sb-results').click();
  80  |   await page.waitForTimeout(2000);
  81  | 
  82  |   // Should no longer be on import view
  83  |   const importView = page.locator('#view-import');
  84  |   const isImportActive = await importView.evaluate(el => el.classList.contains('active'));
  85  | 
  86  |   // Check for the fatal errors that caused this bug before
  87  |   const licenceErrors = consoleErrors.filter(e =>
  88  |     e.includes('refreshLicenceStatus') || e.includes('licenceStatus')
  89  |   );
  90  |   expect(licenceErrors, `Licence errors:\n${licenceErrors.join('\n')}`).toHaveLength(0);
  91  | 
  92  |   // Navigate back to import for next tests
  93  |   await page.locator('#sb-import').click();
  94  |   await page.waitForTimeout(500);
  95  | });
  96  | 
  97  | // ── 7. No doubled file markers in rendered JS ─────────────────────────────────
  98  | test('app.js has no duplicate function declarations', async () => {
  99  |   // Evaluate in page context — check that key functions exist exactly once
  100 |   const counts = await page.evaluate(() => {
  101 |     // We can't grep the source, but we can check that globals exist and are functions
  102 |     return {
  103 |       hasRefreshLicence: typeof refreshLicenceStatus !== 'undefined',
  104 |       hasLoadResults:    typeof loadResults           !== 'undefined',
  105 |       hasShowView:       typeof showView              !== 'undefined',
  106 |       hasOpenLightbox:   typeof openLightbox          !== 'undefined',
  107 |       hasInit:           typeof init                  !== 'undefined',
  108 |     };
  109 |   });
  110 |   expect(counts.hasRefreshLicence, 'refreshLicenceStatus missing').toBe(true);
  111 |   expect(counts.hasLoadResults,    'loadResults missing').toBe(true);
  112 |   expect(counts.hasShowView,       'showView missing').toBe(true);
  113 |   expect(counts.hasOpenLightbox,   'openLightbox missing').toBe(true);
  114 | });
  115 | 
  116 | // ── 8. Lightbox nav buttons exist ────────────────────────────────────────────
  117 | test('lightbox has prev/next navigation buttons', async () => {
  118 |   await expect(page.locator('#lightbox-prev')).toBeAttached();
  119 |   await expect(page.locator('#lightbox-next')).toBeAttached();
  120 | });
  121 | 
  122 | // ── 9. Export buttons exist and are in correct initial state ─────────────────
  123 | test('export buttons are present', async () => {
  124 |   // Navigate to results first
  125 |   await page.locator('#sb-results').click();
  126 |   await page.waitForTimeout(2000);
  127 | 
  128 |   // These should always exist in the DOM
  129 |   await expect(page.locator('#btn-export-csv')).toBeAttached();
  130 |   await expect(page.locator('#btn-export-copy')).toBeAttached();
  131 |   await expect(page.locator('#btn-export-by-date')).toBeAttached();
  132 | 
```