import { defineConfig } from 'vitest/config'
import path from 'path'

import { relativeRequireJsToTs } from './vitest.plugins.js'

/**
 * Default (unit) vitest config. Includes only `src/__tests__/unit/**`
 * so `pnpm test` and `pnpm test:unit` run the fast, deterministic
 * mock-based unit suite.
 *
 * Separate configs:
 *   - `vitest.integration.config.ts` — `src/__tests__/integration/` only (real LLM)
 *   - `vitest.e2e.config.ts`         — `src/__tests__/e2e/` only (full CLI process)
 *   - `vitest.all.config.ts`         — every `*.test.ts(x)` everywhere
 *
 * See `agent/src/__tests__/README.md` for the three-tier convention and
 * where new tests should live.
 */
export default defineConfig({
  plugins: [relativeRequireJsToTs],
  resolve: {
    alias: {
      'bun:bundle': path.resolve(__dirname, 'src/__mocks__/bun-bundle.ts'),
    },
  },
  test: {
    include: ['src/__tests__/unit/**/*.test.{ts,tsx}'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/__tests__/**',
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
