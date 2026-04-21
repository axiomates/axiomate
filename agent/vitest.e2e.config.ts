import { defineConfig, mergeConfig } from 'vitest/config'

import defaultConfig from './vitest.config.js'

/**
 * E2E test config — includes only `src/__tests__/e2e/`.
 * Used by `bun test:e2e`. Currently a placeholder; no e2e tests exist yet.
 */
export default mergeConfig(
  defaultConfig,
  defineConfig({
    test: {
      include: ['src/__tests__/e2e/**/*.test.ts'],
      exclude: ['**/node_modules/**', '**/dist/**'],
    },
  }),
)
