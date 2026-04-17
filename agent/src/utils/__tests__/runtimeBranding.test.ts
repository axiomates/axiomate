import { homedir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  getRemoteApiKeyPath,
  getRemoteOAuthTokenPath,
  getRemoteSessionIngressTokenPath,
  getRemoteTokenDir,
} from '../authFileDescriptor.js'
import { buildInheritedEnvVars } from '../swarm/spawnUtils.js'

const originalRemoteTokenDir = process.env.AXIOMATE_CODE_REMOTE_TOKEN_DIR

afterEach(() => {
  if (originalRemoteTokenDir === undefined) {
    delete process.env.AXIOMATE_CODE_REMOTE_TOKEN_DIR
  } else {
    process.env.AXIOMATE_CODE_REMOTE_TOKEN_DIR = originalRemoteTokenDir
  }
})

describe('Axiomate runtime branding', () => {
  test('forwards the Axiomate code marker to teammate processes', () => {
    const inherited = buildInheritedEnvVars()

    expect(inherited.split(' ')).toContain('AXIOMATE_CODE=1')
    expect(inherited).not.toContain('CLAU' + 'DECODE')
  })

  test('defaults remote token files to the user Axiomate remote directory', () => {
    delete process.env.AXIOMATE_CODE_REMOTE_TOKEN_DIR

    const expectedDir = join(homedir(), '.axiomate', 'remote')

    expect(getRemoteTokenDir()).toBe(expectedDir)
    expect(getRemoteOAuthTokenPath()).toBe(join(expectedDir, '.oauth_token'))
    expect(getRemoteApiKeyPath()).toBe(join(expectedDir, '.api_key'))
    expect(getRemoteSessionIngressTokenPath()).toBe(
      join(expectedDir, '.session_ingress_token'),
    )
  })

  test('honors AXIOMATE_CODE_REMOTE_TOKEN_DIR for remote token files', () => {
    const customDir = join(homedir(), '.axiomate-test-remote')
    process.env.AXIOMATE_CODE_REMOTE_TOKEN_DIR = customDir

    expect(getRemoteTokenDir()).toBe(customDir)
    expect(getRemoteOAuthTokenPath()).toBe(join(customDir, '.oauth_token'))
    expect(getRemoteApiKeyPath()).toBe(join(customDir, '.api_key'))
    expect(getRemoteSessionIngressTokenPath()).toBe(
      join(customDir, '.session_ingress_token'),
    )
  })
})
