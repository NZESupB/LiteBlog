import { defineConfig } from '@playwright/test'
import { existsSync } from 'node:fs'
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  outputDir: './data/e2e-results',
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4317',
    browserName: 'chromium',
    launchOptions: existsSync(chrome) ? { executablePath: chrome } : {},
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node tests/e2e/server.mjs',
    url: 'http://127.0.0.1:4317/api/site',
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10000 },
    timeout: 45000,
  },
})
