import { describe, expect, test } from 'vitest'
import {
  buildFileEditFailureEscalationHint,
  fileEditFailureEscalationTelemetry,
} from '../../../utils/fileEditFailureEscalation.js'

describe('file edit failure escalation hints', () => {
  test('does not render a hint for the first failure', () => {
    expect(
      buildFileEditFailureEscalationHint({
        fileEditFailureEscalation: {
          reason: 'string_not_found',
          path: '/tmp/example.txt',
          count: 1,
          level: 'none',
        },
      }),
    ).toBeNull()
  })

  test('renders a reread hint for repeated string-not-found failures', () => {
    const hint = buildFileEditFailureEscalationHint({
      fileEditFailureEscalation: {
        reason: 'string_not_found',
        path: '/tmp/example.txt',
        count: 2,
        level: 'reread',
      },
    })

    expect(hint).toContain('2nd consecutive FileEdit failure')
    expect(hint).toContain('`old_string` was not found')
    expect(hint).toContain('Read the target area again')
  })

  test('renders a stop hint for repeated multiple-match failures', () => {
    const hint = buildFileEditFailureEscalationHint({
      fileEditFailureEscalation: {
        reason: 'multiple_match',
        path: '/tmp/example.txt',
        count: 3,
        level: 'stop',
      },
    })

    expect(hint).toContain('STOP')
    expect(hint).toContain('3rd consecutive FileEdit failure')
    expect(hint).toContain('matched multiple locations')
    expect(hint).toContain('longer unique `old_string`')
  })

  test('builds telemetry without file paths', () => {
    expect(
      fileEditFailureEscalationTelemetry(
        {
          reason: 'string_not_found',
          path: '/tmp/secret/example.ts',
          count: 2,
          level: 'reread',
        },
        'ts',
      ),
    ).toEqual({
      reason: 'string_not_found',
      count: '2',
      level: 'reread',
      file_extension: 'ts',
    })
  })
})
