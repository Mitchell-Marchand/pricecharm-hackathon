import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env.QUOTING_WEB_URL || 'http://localhost:3100',
    actionTimeout: 15000,
    navigationTimeout: 30000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The e2e build has a Meta pixel id. No test reaches Meta; meta-pixel.spec.ts stands in for it.
    launchOptions: {
      args: [
        '--host-resolver-rules=MAP connect.facebook.net ~NOTFOUND, MAP www.facebook.com ~NOTFOUND',
      ],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  reporter: [['list']],
});
