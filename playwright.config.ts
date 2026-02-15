import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  retries: 1,
  use: {
    baseURL: 'http://localhost:3456',
    headless: true,
    viewport: { width: 390, height: 844 }, // iPhone 14 Pro dimensions
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
  webServer: {
    command: 'node node_modules/tsx/dist/cli.mjs src/server/index.ts',
    port: 3456,
    reuseExistingServer: true,
    timeout: 15000,
  },
});
