import { defineConfig, devices } from '@playwright/test';

// Pages open over file:// from dist/viewer/report.html, so no web server runs.
export default defineConfig({
  testDir: 'test/browser',
  testMatch: '*.test.ts',
  globalSetup: './test/browser/global-setup.ts',
  forbidOnly: true,
  reporter: 'list',
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
