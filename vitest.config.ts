import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'evals/**/*.test.ts'],
    reporters: ['verbose', 'json'],
    outputFile: {
      json: 'evals/results/test-report.json',
    },
    setupFiles: ['./vitest.setup.ts'],
    // Use jsdom for React component tests and browser-API tests
    environmentMatchGlobs: [
      ['src/**/*.test.tsx', 'jsdom'],
      ['src/lib/__tests__/cases.test.ts', 'jsdom'],
    ],
  },
})
