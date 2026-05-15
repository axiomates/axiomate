/**
 * Path/dir helpers shared by build.ts / package-win.ts / package-mac.ts.
 *
 * `resetDistDir` removes any stale outputs (.exe, .node, leftover chunks
 * from a previous build with different features/flags) before the next
 * Bun.build() writes into the same dir. Without it, `pnpm run build`
 * after a `package:win` would leave the .exe and native .node files in
 * place and pnpm start could pick up a mismatched mix.
 */

import { mkdirSync, rmSync } from 'fs'

export function resetDistDir(distDir: string): void {
  rmSync(distDir, { recursive: true, force: true })
  mkdirSync(distDir, { recursive: true })
}
