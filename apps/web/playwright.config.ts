import { defineConfig } from '@playwright/test';
const live = process.env.TEST_REAL_API === 'true';
export default defineConfig({
  testDir: './e2e', testMatch: live ? '**/*.live.spec.ts' : '**/*.mock.spec.ts',
  timeout: 60_000, workers: 1, fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:5187', headless: true, trace: 'retain-on-failure', viewport: { width: 1440, height: 1000 } },
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 5187', port: 5187, reuseExistingServer: false,
    env: { VITE_MOCK_API: live ? 'false' : 'true', API_PROXY_TARGET: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000' },
  },
});
