import { describe, it, expect } from 'vitest'
import {
  computeNextCronRun,
  nextCronRunMs,
  parseCronExpression,
  jitteredNextCronRunMs,
  oneShotJitteredNextCronRunMs,
  DEFAULT_CRON_JITTER_CONFIG,
} from '../src/cron.js'

describe('parseCronExpression', () => {
  it('parses wildcards', () => {
    const fields = parseCronExpression('* * * * *')
    expect(fields).not.toBeNull()
    expect(fields!.minute).toHaveLength(60)
    expect(fields!.hour).toHaveLength(24)
    expect(fields!.dayOfWeek).toHaveLength(7)
  })

  it('parses single values', () => {
    const fields = parseCronExpression('30 14 * * *')!
    expect(fields.minute).toEqual([30])
    expect(fields.hour).toEqual([14])
  })

  it('parses ranges', () => {
    const fields = parseCronExpression('0 9-17 * * *')!
    expect(fields.hour).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
  })

  it('parses step values', () => {
    const fields = parseCronExpression('*/15 * * * *')!
    expect(fields.minute).toEqual([0, 15, 30, 45])
  })

  it('parses comma-lists', () => {
    const fields = parseCronExpression('0,30 * * * *')!
    expect(fields.minute).toEqual([0, 30])
  })

  it('handles dayOfWeek 7 as Sunday (0) alias', () => {
    const fields = parseCronExpression('0 9 * * 7')!
    expect(fields.dayOfWeek).toEqual([0])
  })

  it('returns null for invalid expressions', () => {
    expect(parseCronExpression('invalid')).toBeNull()
    expect(parseCronExpression('60 * * * *')).toBeNull() // minute > 59
    expect(parseCronExpression('0 24 * * *')).toBeNull() // hour > 23
    expect(parseCronExpression('* * 32 * *')).toBeNull() // dom > 31
    expect(parseCronExpression('* * * 13 *')).toBeNull() // month > 12
    expect(parseCronExpression('* * * *')).toBeNull() // 4 fields
    expect(parseCronExpression('* * * * * *')).toBeNull() // 6 fields
  })

  it('returns null for invalid ranges (lo > hi)', () => {
    expect(parseCronExpression('5-3 * * * *')).toBeNull()
  })
})

describe('computeNextCronRun', () => {
  it('computes the next minute for wildcard', () => {
    const fields = parseCronExpression('* * * * *')!
    const from = new Date('2026-05-13T10:30:15.123Z')
    const next = computeNextCronRun(fields, from)
    expect(next).not.toBeNull()
    expect(next!.getTime()).toBeGreaterThan(from.getTime())
    // Should be the next whole minute
    expect(next!.getSeconds()).toBe(0)
    expect(next!.getMilliseconds()).toBe(0)
  })

  it('returns same wall-clock time tomorrow for daily cron when already passed', () => {
    const fields = parseCronExpression('30 9 * * *')!
    const from = new Date(2026, 4, 13, 10, 0, 0) // 10am local time
    const next = computeNextCronRun(fields, from)!
    expect(next.getHours()).toBe(9)
    expect(next.getMinutes()).toBe(30)
    expect(next.getDate()).toBe(14)
  })

  it('returns today when daily cron is still ahead', () => {
    const fields = parseCronExpression('30 14 * * *')!
    const from = new Date(2026, 4, 13, 10, 0, 0)
    const next = computeNextCronRun(fields, from)!
    expect(next.getHours()).toBe(14)
    expect(next.getMinutes()).toBe(30)
    expect(next.getDate()).toBe(13)
  })

  it('honors dayOfWeek constraint', () => {
    // Every Monday at 09:00
    const fields = parseCronExpression('0 9 * * 1')!
    // 2026-05-13 is a Wednesday
    const from = new Date(2026, 4, 13, 12, 0, 0)
    const next = computeNextCronRun(fields, from)!
    expect(next.getDay()).toBe(1) // Monday
    expect(next.getHours()).toBe(9)
  })
})

describe('nextCronRunMs', () => {
  it('returns ms timestamp strictly after fromMs', () => {
    const from = Date.now()
    const next = nextCronRunMs('* * * * *', from)
    expect(next).toBeGreaterThan(from)
  })

  it('returns null for invalid cron', () => {
    expect(nextCronRunMs('invalid', Date.now())).toBeNull()
  })
})

describe('jitteredNextCronRunMs', () => {
  it('is deterministic for the same taskId', () => {
    const now = Date.now()
    const a = jitteredNextCronRunMs('0 * * * *', now, 'abcd1234')
    const b = jitteredNextCronRunMs('0 * * * *', now, 'abcd1234')
    expect(a).toBe(b)
  })

  it('produces different jitter for different taskIds', () => {
    const now = Date.now()
    const a = jitteredNextCronRunMs('0 * * * *', now, '00000000')
    const b = jitteredNextCronRunMs('0 * * * *', now, 'ffffffff')
    expect(a).not.toBe(b)
  })

  it('respects recurringCapMs', () => {
    // A very long interval — jitter should not exceed cap
    const now = new Date(2026, 0, 1, 0, 0, 0).getTime()
    // Annual cron: jitter at default frac=0.1 of a year = ~36 days; cap=15min
    const t1 = nextCronRunMs('0 0 1 1 *', now)!
    const withJitter = jitteredNextCronRunMs('0 0 1 1 *', now, 'ffffffff')!
    const delta = withJitter - t1
    expect(delta).toBeGreaterThanOrEqual(0)
    expect(delta).toBeLessThanOrEqual(DEFAULT_CRON_JITTER_CONFIG.recurringCapMs)
  })
})

describe('oneShotJitteredNextCronRunMs', () => {
  it('does not jitter minutes that do not match oneShotMinuteMod', () => {
    // 14:23 every day — :23 % 30 != 0, so no jitter
    const now = new Date(2026, 4, 13, 10, 0, 0).getTime()
    const expected = nextCronRunMs('23 14 * * *', now)!
    const jittered = oneShotJitteredNextCronRunMs('23 14 * * *', now, 'ffffffff')!
    expect(jittered).toBe(expected)
  })

  it('jitters minutes that match oneShotMinuteMod (default 30)', () => {
    // 14:00 every day — :00 % 30 === 0, so jitter applies
    const now = new Date(2026, 4, 13, 10, 0, 0).getTime()
    const expected = nextCronRunMs('0 14 * * *', now)!
    const jittered = oneShotJitteredNextCronRunMs('0 14 * * *', now, 'ffffffff')!
    expect(jittered).toBeLessThanOrEqual(expected)
    expect(expected - jittered).toBeLessThanOrEqual(DEFAULT_CRON_JITTER_CONFIG.oneShotMaxMs)
  })

  it('clamps to fromMs', () => {
    // Task is created at the same time as its expected fire — jittered
    // value must not go before fromMs
    const fireAt = new Date(2026, 4, 13, 14, 0, 0).getTime()
    const now = fireAt - 1000 // 1s before
    const jittered = oneShotJitteredNextCronRunMs('0 14 * * *', now, 'ffffffff')!
    expect(jittered).toBeGreaterThanOrEqual(now)
  })
})
