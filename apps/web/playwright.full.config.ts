import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

const origin = new URL(process.env.FULL_STACK_BASE_URL ?? 'http://127.0.0.1:8080');
if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
  origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
  throw new Error('FULL_STACK_BASE_URL must be a local HTTP origin');
}

export default defineConfig({
  ...base,
  testMatch: process.env.FULL_STACK_LARGE_UPLOAD === 'true' ? '**/*.large.spec.ts' : '**/*.live.spec.ts',
  projects: [{ name: 'compose' }],
  webServer: undefined,
  use: { ...base.use, baseURL: origin.origin },
});
