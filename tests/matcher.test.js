// tests/matcher.test.js
// Unit tests for the sidecar matching algorithm.
// Run with: node tests/matcher.test.js
// No test framework needed — uses Node's assert module.

'use strict';

const assert = require('assert');
const path   = require('path');
const { buildJsonIndex, findSidecar, dateFromFilename } = require('../src/processors/sidecarMatcher');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     Expected: ${err.expected}`);
    console.error(`     Actual:   ${err.actual}`);
    failed++;
  }
}

function makeIndex(names) {
  // buildJsonIndex expects full paths — we fake them with /photos/ prefix
  return buildJsonIndex(names.map(n => path.join('/photos', n)));
}

function findFor(mediaName, jsonNames) {
  const index  = makeIndex(jsonNames);
  const result = findSidecar(path.join('/photos', mediaName), index);
  return result ? path.basename(result) : null;
}

// ── Strategy 1: old format ────────────────────────────────────────────────────
console.log('\n── Strategy 1: Old format (pre-2024) ────────────────────────────');

test('standard old format', () => {
  const r = findFor('IMG_1234.jpg', ['IMG_1234.jpg.json']);
  assert.strictEqual(r, 'IMG_1234.jpg.json');
});

test('HEIC old format', () => {
  const r = findFor('IMG_1234.HEIC', ['IMG_1234.HEIC.json']);
  assert.strictEqual(r, 'IMG_1234.HEIC.json');
});

test('MP4 old format', () => {
  const r = findFor('VID_001.mp4', ['VID_001.mp4.json']);
  assert.strictEqual(r, 'VID_001.mp4.json');
});

test('case insensitive match', () => {
  const r = findFor('IMG_1234.JPG', ['IMG_1234.JPG.json']);
  assert.strictEqual(r, 'IMG_1234.JPG.json');
});

// ── Strategy 2: new format ────────────────────────────────────────────────────
console.log('\n── Strategy 2: New format (2024+) ───────────────────────────────');

test('new supplemental-metadata format', () => {
  const r = findFor('IMG_1234.jpg', ['IMG_1234.jpg.supplemental-metadata.json']);
  assert.strictEqual(r, 'IMG_1234.jpg.supplemental-metadata.json');
});

test('new format with PXL filename', () => {
  const r = findFor(
    'PXL_20230101_120000000.jpg',
    ['PXL_20230101_120000000.jpg.supplemental-metadata.json']
  );
  assert.strictEqual(r, 'PXL_20230101_120000000.jpg.supplemental-metadata.json');
});

// ── Strategy 3: truncated filenames ──────────────────────────────────────────
console.log('\n── Strategy 3: Truncated filenames ──────────────────────────────');

test('truncated supplemental-metadata (Google 46-char limit)', () => {
  // PXL_20230815_142536789.jpg.supplemental-metadata.json = 53 chars → truncated
  // Google keeps first 42 chars of stem + .json
  const truncated = 'PXL_20230815_142536789.jpg.supplemental-m.json';
  const r = findFor('PXL_20230815_142536789.jpg', [truncated]);
  assert.notStrictEqual(r, null, 'Should find truncated sidecar');
});

test('prefix scan fallback for truncated', () => {
  // Different truncation point — rely on prefix scan
  const truncated = 'PXL_20221231_235959999.jpg.supple.json';
  const r = findFor('PXL_20221231_235959999.jpg', [truncated]);
  assert.notStrictEqual(r, null, 'Prefix scan should find it');
});

test('short filename does not trigger truncation path', () => {
  // "a.jpg.supplemental-metadata.json" is only 33 chars — no truncation
  const r = findFor('a.jpg', ['a.jpg.supplemental-metadata.json']);
  assert.strictEqual(r, 'a.jpg.supplemental-metadata.json');
});

// ── Strategy 4a: edited suffix ────────────────────────────────────────────────
console.log('\n── Strategy 4a: Edited suffix ───────────────────────────────────');

test('edited suffix -> original sidecar', () => {
  const r = findFor('IMG_1234-edited.jpg', ['IMG_1234.jpg.json']);
  assert.strictEqual(r, 'IMG_1234.jpg.json');
});

test('edited suffix with new format sidecar', () => {
  const r = findFor('IMG_1234-edited.jpg', ['IMG_1234.jpg.supplemental-metadata.json']);
  assert.strictEqual(r, 'IMG_1234.jpg.supplemental-metadata.json');
});

// ── Strategy 4b: duplicate suffix ────────────────────────────────────────────
console.log('\n── Strategy 4b: Duplicate suffix ────────────────────────────────');

test('(1) duplicate suffix', () => {
  const r = findFor('IMG_1234(1).jpg', ['IMG_1234.jpg.json']);
  assert.strictEqual(r, 'IMG_1234.jpg.json');
});

test('(2) duplicate suffix', () => {
  const r = findFor('IMG_1234(2).jpg', ['IMG_1234.jpg.json']);
  assert.strictEqual(r, 'IMG_1234.jpg.json');
});

test('space before duplicate number', () => {
  const r = findFor('IMG_1234 (1).jpg', ['IMG_1234.jpg.json']);
  assert.strictEqual(r, 'IMG_1234.jpg.json');
});

// ── No match ──────────────────────────────────────────────────────────────────
console.log('\n── No match cases ───────────────────────────────────────────────');

test('returns null when no sidecar exists', () => {
  const r = findFor('IMG_9999.jpg', ['IMG_1234.jpg.json']);
  assert.strictEqual(r, null);
});

test('does not cross-match wrong file', () => {
  const r = findFor('IMG_5678.jpg', ['IMG_1234.jpg.json', 'IMG_9999.jpg.json']);
  assert.strictEqual(r, null);
});

// ── dateFromFilename ──────────────────────────────────────────────────────────
console.log('\n── dateFromFilename ──────────────────────────────────────────────');

test('PXL_ Pixel format', () => {
  const ts = dateFromFilename('PXL_20230815_142536789.jpg');
  const d  = new Date(ts);
  assert.strictEqual(d.getUTCFullYear(), 2023);
  assert.strictEqual(d.getUTCMonth(), 7); // 0-indexed
  assert.strictEqual(d.getUTCDate(), 15);
});

test('IMG_ Android format', () => {
  const ts = dateFromFilename('IMG_20230101_120000.jpg');
  const d  = new Date(ts);
  assert.strictEqual(d.getUTCFullYear(), 2023);
  assert.strictEqual(d.getUTCMonth(), 0);
  assert.strictEqual(d.getUTCDate(), 1);
});

test('Screenshot_ format', () => {
  const ts = dateFromFilename('Screenshot_20221231-235959.png');
  const d  = new Date(ts);
  assert.strictEqual(d.getUTCFullYear(), 2022);
  assert.strictEqual(d.getUTCMonth(), 11);
  assert.strictEqual(d.getUTCDate(), 31);
});

test('returns null for random filename', () => {
  const ts = dateFromFilename('random_photo.jpg');
  assert.strictEqual(ts, null);
});

test('YYYY-MM-DD fallback', () => {
  const ts = dateFromFilename('photo-2019-06-15-trip.jpg');
  const d  = new Date(ts);
  assert.strictEqual(d.getUTCFullYear(), 2019);
  assert.strictEqual(d.getUTCMonth(), 5);
});

test('rejects implausible dates (year 1970)', () => {
  const ts = dateFromFilename('IMG_19700101_000000.jpg');
  // Should be null or a very early date — we reject dates before ~1990
  if (ts !== null) {
    const year = new Date(ts).getUTCFullYear();
    assert.ok(year >= 1990, `Year ${year} is implausibly early`);
  }
});

// ── Index lookup performance ──────────────────────────────────────────────────
console.log('\n── Performance sanity ───────────────────────────────────────────');

test('handles large index without error', () => {
  const bigNames = Array.from({ length: 10000 }, (_, i) =>
    `IMG_${String(i).padStart(5, '0')}.jpg.json`
  );
  const index = makeIndex(bigNames);
  const r = findFor('IMG_00999.jpg', bigNames);
  assert.strictEqual(r, 'IMG_00999.jpg.json');
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`  ${passed} passed  |  ${failed} failed`);
if (failed > 0) {
  console.log(`\n  Fix the failing cases before starting Sprint 1.`);
  process.exit(1);
} else {
  console.log(`\n  All tests pass. Matcher is ready.\n`);
}
