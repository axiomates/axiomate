import { defineConfig, mergeConfig } from 'vitest/config'

import defaultConfig from './vitest.config.js'

/**
 * Integration test config — includes only `src/__tests__/integration/`.
 * Used by `bun test:integration`.
 */
export default mergeConfig(
  defaultConfig,
  defineConfig({
    test: {
      // Override: include integration, exclude everything else
      include: ['src/__tests__/integration/**/*.test.ts'],
      exclude: ['**/node_modules/**', '**/dist/**'],
    },
  }),
)
