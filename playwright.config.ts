/**
 * Playwright smoke config (PRD 7.5): boots the production-mode server — the
 * built server bundle serving the built client — in E2E test mode (fixed
 * TEST_SEED, zero bot pacing) and runs e2e/ against it headless in Chromium.
 * Run via `pnpm e2e`, which builds first; the whole run stays under ~2 min.
 */

import { defineConfig } from '@playwright/test';
import { TEST_HARD_BUDGET_MS, TEST_SEED } from './e2e/seed.ts';

const port = Number(process.env.E2E_PORT ?? 8543);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL,
    headless: true,
    browserName: 'chromium',
  },
  webServer: {
    command: 'node apps/server/dist/index.js',
    url: `${baseURL}/healthz`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      PORT: String(port),
      TEST_SEED: String(TEST_SEED),
      // Every seat is a Hard bot (fh-gpk); trim the rollout budget so a
      // browser-paced hand still finishes inside the suite's time box.
      HARD_BOT_BUDGET_MS: String(TEST_HARD_BUDGET_MS),
    },
  },
});
