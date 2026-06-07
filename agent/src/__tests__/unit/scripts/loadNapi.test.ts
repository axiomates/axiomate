import { createRequire } from 'module'
import { dirname, join } from 'path'
import { describe, expect, test, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { getNapiSearchDirs } = require('../../../../../scripts/load-napi.js') as {
  getNapiSearchDirs(packageDir: string): string[]
}

describe('load-napi search order', () => {
  test('compiled exe searches only next to the executable, not baked workspace __dirname', () => {
    const packageDir = 'C:\\public\\workspace\\axiomate\\computer-use-win-napi-axiomate'
    const exePath = 'C:\\public\\tools\\axiomate\\axiomate.exe'

    vi.spyOn(process, 'execPath', 'get').mockReturnValue(exePath)

    expect(getNapiSearchDirs(packageDir)).toEqual([dirname(exePath)])
  })

  test('compiled unix binary also searches only next to the executable', () => {
    const packageDir = '/Users/builder/workspace/axiomate/audio-capture-axiomate'
    const exePath = '/opt/axiomate/axiomate'

    vi.spyOn(process, 'execPath', 'get').mockReturnValue(exePath)

    expect(getNapiSearchDirs(packageDir)).toEqual([dirname(exePath)])
  })

  test('interpreter workspace execution prefers the workspace package directory', () => {
    const packageDir = 'C:\\public\\workspace\\axiomate\\computer-use-win-napi-axiomate'
    const bunPath = join('C:\\Users\\kiro', '.bun', 'bin', 'bun.exe')

    vi.spyOn(process, 'execPath', 'get').mockReturnValue(bunPath)

    expect(getNapiSearchDirs(packageDir)).toEqual([
      packageDir,
      dirname(bunPath),
    ])
  })
})
