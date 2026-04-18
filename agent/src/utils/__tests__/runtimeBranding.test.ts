import { describe, expect, test } from 'vitest'
import { buildInheritedEnvVars } from '../swarm/spawnUtils.js'

describe('Axiomate runtime branding', () => {
  test('forwards the Axiomate code marker to teammate processes', () => {
    const inherited = buildInheritedEnvVars()

    expect(inherited.split(' ')).toContain('AXIOMATE_CODE=1')
    expect(inherited).not.toContain('CLAU' + 'DECODE')
  })
})
