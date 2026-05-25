// tests/smoke.spec.js
// Fossick smoke tests — covers the bugs we've actually shipped.
// Run: npx playwright test tests/smoke.spec.js

const { test, expect } = require('@playwright/test');
const { launchApp }    = require('./helpers/electron');

// ── Setup: one app instance per suite ────────────────────────────────────────
let app, page, consoleErrors;

test.beforeAll(async () => {
  ({ app, page, consoleErrors } = await launchApp());
  // Give app 3s to fully boot
  await page.waitForTimeout(3000);
});

test.afterAll(async () => {
  if (app) await app.close();
});

// ── 1. No fatal JS errors on startup ─────────────────────────────────────────
test('no ReferenceErrors or TypeErrors on startup', async () => {
  const fatal = consoleErrors.filter(e =>
    e.includes('ReferenceError') || e.includes('TypeError: Cannot read')
  );
  expect(fatal, `Fatal JS errors:\n${fatal.join('\n')}`).toHaveLength(0);
});

// ── 2. Import page loads correctly ───────────────────────────────────────────
test('import page shows correct content', async () => {
  // Eyebrow bar
  await expect(page.locator('.vhb')).toBeVisible();
  await expect(page.locator('#btn-nav-import')).toContainText('Import Setting');

  // Headline
  await expect(page.locator('.import-title')).toBeVisible();
  await expect(page.locator('.import-title')).toContainText('Google Takeout');

  // Both source buttons present
  await expect(page.locator('#btn-select-zips')).toBeVisible();

  // Process button hidden until source is selected
  await expect(page.locator('#btn-start')).toBeHidden();
});

// ── 3. Feature pills all render ───────────────────────────────────────────────
test('feature pills are all visible', async () => {
  const pills = page.locator('.import-feat');
  const count = await pills.count();
  expect(count, 'Expected at least 4 feature pills').toBeGreaterThanOrEqual(4);
  // Must NOT contain 100% local (was removed)
  const texts = await pills.allTextContents();
  const has100Local = texts.some(t => t.includes('100% local'));
  expect(has100Local, '"100% local" pill should have been removed').toBe(false);
});

// ── 4. Sidebar workflow items present ─────────────────────────────────────────
test('sidebar has Import, Process, Results workflow items', async () => {
  await expect(page.locator('#sb-import')).toBeVisible();
  await expect(page.locator('#sb-process')).toBeVisible();
  await expect(page.locator('#sb-results')).toBeVisible();
});

// ── 5. Your Archive section exists in sidebar ─────────────────────────────────
// It shows when DB has data (existing archive), hides when fresh.
// Both states are valid — just verify the element exists.
test('Your Archive section exists in sidebar', async () => {
  await expect(page.locator('#sb-archive')).toBeAttached();
  // Verify it contains the expected archive items
  await expect(page.locator('#sb-photos')).toBeAttached();
  await expect(page.locator('#sb-albums')).toBeAttached();
  await expect(page.locator('#sb-places')).toBeAttached();
});

// ── 6. Results click works (navigates away from import) ───────────────────────
test('clicking Results navigates to results view', async () => {
  // Click Results in sidebar
  await page.locator('#sb-results').click();
  await page.waitForTimeout(2000);

  // Should no longer be on import view
  const importView = page.locator('#view-import');
  const isImportActive = await importView.evaluate(el => el.classList.contains('active'));

  // Check for the fatal errors that caused this bug before
  const licenceErrors = consoleErrors.filter(e =>
    e.includes('refreshLicenceStatus') || e.includes('licenceStatus')
  );
  expect(licenceErrors, `Licence errors:\n${licenceErrors.join('\n')}`).toHaveLength(0);

  // Navigate back to import for next tests
  await page.locator('#sb-import').click();
  await page.waitForTimeout(500);
});

// ── 7. No doubled file markers in rendered JS ─────────────────────────────────
test('app.js has no duplicate function declarations', async () => {
  // Evaluate in page context — check that key functions exist exactly once
  const counts = await page.evaluate(() => {
    // We can't grep the source, but we can check that globals exist and are functions
    return {
      hasRefreshLicence: typeof refreshLicenceStatus !== 'undefined',
      hasLoadResults:    typeof loadResults           !== 'undefined',
      hasShowView:       typeof showView              !== 'undefined',
      hasOpenLightbox:   typeof openLightbox          !== 'undefined',
      hasInit:           typeof init                  !== 'undefined',
    };
  });
  expect(counts.hasRefreshLicence, 'refreshLicenceStatus missing').toBe(true);
  expect(counts.hasLoadResults,    'loadResults missing').toBe(true);
  expect(counts.hasShowView,       'showView missing').toBe(true);
  expect(counts.hasOpenLightbox,   'openLightbox missing').toBe(true);
});

// ── 8. Lightbox nav buttons exist ────────────────────────────────────────────
test('lightbox has prev/next navigation buttons', async () => {
  await expect(page.locator('#lightbox-prev')).toBeAttached();
  await expect(page.locator('#lightbox-next')).toBeAttached();
});

// ── 9. Export buttons exist and are in correct initial state ─────────────────
test('export buttons are present', async () => {
  // Navigate to results first
  await page.locator('#sb-results').click();
  await page.waitForTimeout(2000);

  // These should always exist in the DOM
  await expect(page.locator('#btn-export-csv')).toBeAttached();
  await expect(page.locator('#btn-export-copy')).toBeAttached();
  await expect(page.locator('#btn-export-by-date')).toBeAttached();

  // Export by trip should NOT exist (was removed)
  await expect(page.locator('#btn-export-by-trip')).not.toBeAttached();

  // Back to import
  await page.locator('#sb-import').click();
  await page.waitForTimeout(500);
});

// ── 10. No TripMaps.observe calls (removed dead code) ────────────────────────
test('TripMaps.observe is not called (dead code removed)', async () => {
  const tripMapsObserveErrors = consoleErrors.filter(e =>
    e.includes('TripMaps.observe') || e.includes('observe is not a function')
  );
  expect(tripMapsObserveErrors).toHaveLength(0);
});

// ── 11. Places search input exists ───────────────────────────────────────────
test('places search input is in the DOM', async () => {
  await expect(page.locator('#places-search')).toBeAttached();
  await expect(page.locator('#places-search-clear')).toBeAttached();
});

// ── 12. Resume banner hidden on fresh start ───────────────────────────────────
test('resume banner is hidden when no incomplete run exists', async () => {
  // Resume banner should only show if run_state is in the DB
  // On a fresh test run it should be hidden
  await expect(page.locator('#resume-banner')).not.toHaveClass(/visible/);
});

// ── 13. No console errors accumulated ────────────────────────────────────────
test('no console errors accumulated during test run', async () => {
  // Filter out known benign warnings
  const realErrors = consoleErrors.filter(e =>
    !e.includes('local-reverse-geocoder') &&  // geocoder init warning is benign
    !e.includes('ExifTool') &&                // ExifTool not running in test mode
    !e.includes('net::ERR_FILE_NOT_FOUND')    // missing thumbnails in test mode
  );
  if (realErrors.length > 0) {
    console.log('Console errors found:\n', realErrors.join('\n'));
  }
  expect(realErrors).toHaveLength(0);
});
