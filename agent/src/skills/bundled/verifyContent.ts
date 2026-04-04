// Content for the verify bundled skill.
// Originally inlined as strings at build time via Bun's text loader.
// Under Node we read them from disk at runtime.

import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))
const mdDir = join(__dir, 'verify')

function readMd(relativePath: string): string {
  try {
    return readFileSync(join(mdDir, relativePath), 'utf-8')
  } catch {
    return ''
  }
}

export const SKILL_MD: string = readMd('SKILL.md')

export const SKILL_FILES: Record<string, string> = {
  'examples/cli.md': readMd('examples/cli.md'),
  'examples/server.md': readMd('examples/server.md'),
}
