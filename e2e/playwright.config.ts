import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

// Some environments ship a prebuilt Chromium instead of letting Playwright
// download its own. Use it when it is there; otherwise rely on the browser
// `npx playwright install chromium` puts in place (what CI does).
const preinstalled = process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium';
const executablePath = existsSync(preinstalled) ? preinstalled : undefined;

export default defineConfig({
  testDir: './specs',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // `github` annotates the diff, `list` reads in the log — and neither writes
  // anything to disk, so the workflow's failure artifact was uploading an
  // empty directory it warned about and nobody read. `html` is the one that
  // produces a report, and it copies each failure's trace in beside it, so the
  // upload is self-contained. `open: 'never'` because CI has no browser.
  reporter: process.env.CI ? [['github'], ['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      // A phone viewport: most of this app's UI decisions are mobile-first.
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'], launchOptions: { executablePath } },
    },
  ],
  // Tests run against the production build, not the dev server — the service
  // worker, the PWA manifest and the hashed bundles only exist there.
  webServer: {
    command: `pnpm --filter web build && pnpm --filter web preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    cwd: '..',
  },
});
