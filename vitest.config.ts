import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['tests/unit/**/*.test.{ts,tsx,js}'], environment: 'jsdom', environmentOptions: { jsdom: { url: 'http://localhost/' } }, restoreMocks: true, clearMocks: true } })
