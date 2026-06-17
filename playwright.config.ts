import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['html'], ['list']],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  expect: {
    // The identity diff (N15c) is pixel-stable by construction (a fixed cube, no
    // model call); a tiny ratio absorbs only sub-pixel font antialiasing, not
    // layout/content drift, so a real regression in the 1×1 path still fails.
    toHaveScreenshot: { maxDiffPixelRatio: 0.01 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // E2E_FIXTURES enables the test-only render seams (e.g. the N15c 1×1 identity
    // fixture at /notebook/score-fixture); they 404 in the product without it.
    command: 'E2E_FIXTURES=1 npm start',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
  },
})
