const { defineConfig } = require('@playwright/test');
const path = require('path');

module.exports = defineConfig({
  testDir:   path.join(__dirname, 'tests'),
  testMatch: '**/*.spec.js',
  timeout:   120_000,
  retries:   0,
  reporter:  [['list'], ['html', { open: 'never' }]],
  use: { screenshot: 'only-on-failure' },
});
