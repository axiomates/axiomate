import { describe, expect, test } from 'vitest'
import { buildFileReadDedupEscalationHint } from '../../../utils/fileReadDedupEscalation.js'

describe('file read dedup escalation hints', () => {
  test('keeps the first dedup hit quiet', () => {
    expect(
      buildFileReadDedupEscalationHint({ count: 1, level: 'none' }),
    ).toBe('')
  })

  test('renders repeated-read guidance', () => {
    const hint = buildFileReadDedupEscalationHint({
      count: 2,
      level: 'reread-loop',
    })

    expect(hint).toContain('Repeated Read calls')
    expect(hint).toContain('earlier Read result')
  })

  test('renders stop guidance', () => {
    const hint = buildFileReadDedupEscalationHint({
      count: 3,
      level: 'stop',
    })

    expect(hint).toContain('STOP')
    expect(hint).toContain('different offset/range')
  })
})
