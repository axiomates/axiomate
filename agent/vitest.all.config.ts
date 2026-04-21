import { defineConfig, mergeConfig } from 'vitest/config'

import defaultConfig from './vitest.config.js'

/**
 * Run-everything config — unit + integration + e2e.
 * Used by `bun test:all` and `bun test:coverage:all`.
 */
export default mergeConfig(
  defaultConfig,
  defineConfig({
    test: {
      // Override exclude: drop integration/e2e exclusions from the default
      exclude: ['**/node_modules/**', '**/dist/**'],
    },
  }),
)
