import { defineConfig } from 'vitest/config'
import path from 'path'

/**
 * Default (unit) vitest config. Excludes the integration and e2e test
 * folders so `bun test` runs fast and deterministic.
 *
 * Separate configs:
 *   - `vitest.integration.config.ts` — overrides to include integration tests
 *   - `vitest.e2e.config.ts` — overrides to include e2e tests
 *   - `vitest.all.config.ts` — includes everything
 */
export default defineConfig({
  resolve: {
    alias: {
      'bun:bundle': path.resolve(__dirname, 'src/__mocks__/bun-bundle.ts'),
    },
  },
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'src/__tests__/integration/**',
      'src/__tests__/e2e/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        '**/__tests__/**',
        '**/__mocks__/**',
        'src/**/*.d.ts',
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
        'vitest.config.ts',
        'vitest.*.config.ts',
        'build.ts',
        'package-*.ts',
        'dist/**',
        'node_modules/**',
      ],
      // Thresholds unset: record baseline first, enforce later.
    },
  },
})
