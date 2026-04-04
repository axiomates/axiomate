// Content for the claude-api bundled skill.
// Originally inlined as strings at build time via Bun's text loader.
// Under Node we read them from disk at runtime.

import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))
const mdDir = join(__dir, 'claude-api')

function readMd(relativePath: string): string {
  try {
    return readFileSync(join(mdDir, relativePath), 'utf-8')
  } catch {
    return ''
  }
}

// @[MODEL LAUNCH]: Update the model IDs/names below. These are substituted into {{VAR}}
// placeholders in the .md files at runtime before the skill prompt is sent.
// After updating these constants, manually update the two files that still hardcode models:
//   - claude-api/SKILL.md (Current Models pricing table)
//   - claude-api/shared/models.md (full model catalog with legacy versions and alias mappings)
export const SKILL_MODEL_VARS = {
  OPUS_ID: 'claude-opus-4-6',
  OPUS_NAME: 'Claude Opus 4.6',
  SONNET_ID: 'claude-sonnet-4-6',
  SONNET_NAME: 'Claude Sonnet 4.6',
  HAIKU_ID: 'claude-haiku-4-5',
  HAIKU_NAME: 'Claude Haiku 4.5',
  // Previous Sonnet ID — used in "do not append date suffixes" example in SKILL.md.
  PREV_SONNET_ID: 'claude-sonnet-4-5',
} satisfies Record<string, string>

export const SKILL_PROMPT: string = readMd('SKILL.md')

export const SKILL_FILES: Record<string, string> = {
  'csharp/claude-api.md': readMd('csharp/claude-api.md'),
  'curl/examples.md': readMd('curl/examples.md'),
  'go/claude-api.md': readMd('go/claude-api.md'),
  'java/claude-api.md': readMd('java/claude-api.md'),
  'php/claude-api.md': readMd('php/claude-api.md'),
  'python/agent-sdk/README.md': readMd('python/agent-sdk/README.md'),
  'python/agent-sdk/patterns.md': readMd('python/agent-sdk/patterns.md'),
  'python/claude-api/README.md': readMd('python/claude-api/README.md'),
  'python/claude-api/batches.md': readMd('python/claude-api/batches.md'),
  'python/claude-api/files-api.md': readMd('python/claude-api/files-api.md'),
  'python/claude-api/streaming.md': readMd('python/claude-api/streaming.md'),
  'python/claude-api/tool-use.md': readMd('python/claude-api/tool-use.md'),
  'ruby/claude-api.md': readMd('ruby/claude-api.md'),
  'shared/error-codes.md': readMd('shared/error-codes.md'),
  'shared/live-sources.md': readMd('shared/live-sources.md'),
  'shared/models.md': readMd('shared/models.md'),
  'shared/prompt-caching.md': readMd('shared/prompt-caching.md'),
  'shared/tool-use-concepts.md': readMd('shared/tool-use-concepts.md'),
  'typescript/agent-sdk/README.md': readMd('typescript/agent-sdk/README.md'),
  'typescript/agent-sdk/patterns.md': readMd('typescript/agent-sdk/patterns.md'),
  'typescript/claude-api/README.md': readMd('typescript/claude-api/README.md'),
  'typescript/claude-api/batches.md': readMd('typescript/claude-api/batches.md'),
  'typescript/claude-api/files-api.md': readMd('typescript/claude-api/files-api.md'),
  'typescript/claude-api/streaming.md': readMd('typescript/claude-api/streaming.md'),
  'typescript/claude-api/tool-use.md': readMd('typescript/claude-api/tool-use.md'),
}
