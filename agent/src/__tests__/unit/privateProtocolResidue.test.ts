import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, test } from 'vitest'

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
)

function parts(...chunks: string[]): string {
  return chunks.join('')
}

const forbiddenResidue = [
  { label: 'legacy env marker', value: parts('CLAU', 'DECODE') },
  { label: 'private IDE auth header', value: parts('X-Clau', 'de-Code') },
  { label: 'private MCP metadata namespace', value: parts('clau', 'decode/') },
  { label: 'private IDE URI prefix', value: parts('_clau', 'de_fs_right') },
  { label: 'hardcoded remote home path', value: parts('/home/clau', 'de') },
  {
    label: 'legacy local settings path',
    value: parts('.clau', 'de/settings.local.json'),
  },
  { label: 'legacy plugin CLI command', value: parts('clau', 'de plugin') },
  {
    label: 'legacy marketplace CLI command',
    value: parts('clau', 'de marketplace remove'),
  },
  {
    label: 'legacy keybindings schema slug',
    value: parts('clau', 'de-code-keybindings'),
  },
]

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
}

describe('private protocol residue audit', () => {
  test('does not reintroduce private legacy wire names or paths', () => {
    const hits: string[] = []

    for (const file of trackedFiles()) {
      const absolutePath = resolve(repoRoot, file)
      let content: string

      try {
        content = readFileSync(absolutePath, 'utf8')
      } catch {
        continue
      }

      const haystacks = [file, content].map(value => value.toLowerCase())
      for (const { label, value } of forbiddenResidue) {
        const needle = value.toLowerCase()
        if (haystacks.some(haystack => haystack.includes(needle))) {
          hits.push(`${file}: ${label}`)
        }
      }
    }

    expect(hits).toEqual([])
  })

  test('bundled keybinding guidance uses the Axiomate schema URL', () => {
    const keybindingsSkill = readFileSync(
      resolve(repoRoot, 'agent/src/skills/bundled/keybindings.ts'),
      'utf8',
    )

    expect(keybindingsSkill).toContain(
      'https://www.schemastore.org/axiomate-keybindings.json',
    )
  })

  test('API provider test fixtures use neutral model names', () => {
    const apiTestFiles = trackedFiles().filter(file =>
      file.startsWith('agent/src/__tests__/unit/services/api/'),
    )
    const familyPattern = new RegExp(
      `\\b(${parts('op', 'us')}|${parts('son', 'net')}|${parts('hai', 'ku')}|${parts('son', 'nect')})\\b`,
      'i',
    )
    const prefixedModelPattern = new RegExp(parts('clau', 'de-'), 'i')
    const hits: string[] = []

    for (const file of apiTestFiles) {
      const content = readFileSync(resolve(repoRoot, file), 'utf8')
      if (familyPattern.test(content) || prefixedModelPattern.test(content)) {
        hits.push(file)
      }
    }

    expect(hits).toEqual([])
  })
})
