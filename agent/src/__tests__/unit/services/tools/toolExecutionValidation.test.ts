import { describe, expect, test } from 'vitest'
import { buildToolValidationErrorContent } from '../../../../services/tools/toolExecution.js'

describe('buildToolValidationErrorContent', () => {
  test('preserves validation messages without escalation metadata', () => {
    expect(
      buildToolValidationErrorContent({
        result: false,
        behavior: 'ask',
        message: 'String to replace not found in file.\nString: gamma',
        errorCode: 8,
      }),
    ).toBe('String to replace not found in file.\nString: gamma')
  })

  test('appends FileEdit escalation guidance to validation messages', () => {
    const content = buildToolValidationErrorContent({
      result: false,
      behavior: 'ask',
      message: 'String to replace not found in file.\nString: delta',
      errorCode: 8,
      meta: {
        fileEditFailureEscalation: {
          reason: 'string_not_found',
          path: '/tmp/example.txt',
          count: 2,
          level: 'reread',
        },
      },
    })

    expect(content).toContain('String to replace not found in file')
    expect(content).toContain('2nd consecutive FileEdit failure')
    expect(content).toContain('Read the target area again')
  })
})
