import { describe, expect, it } from 'vitest'

import type { Mark } from './clickTarget.js'
import { summarizeMarks } from './detection.js'

const marks: Mark[] = [
  { id: 1, x: 10, y: 10, name: 'Send', role: 'Button', source: 'uia', confidence: 1 },
  { id: 2, x: 80, y: 20, name: 'Cancel', role: 'Button', source: 'uia', confidence: 1 },
  { id: 3, x: 15, y: 80, name: 'Message', role: 'Edit', source: 'uia', confidence: 1 },
  { id: 4, x: 85, y: 85, name: 'Settings', role: 'MenuItem', source: 'uia', confidence: 1 },
]

describe('summarizeMarks', () => {
  it('returns grouped roles, query hits, and tiles', () => {
    const summary = summarizeMarks(marks, { x: 0, y: 0, w: 100, h: 100 }, {
      shownCount: 2,
      query: 'send',
    })

    expect(summary.totalCount).toBe(4)
    expect(summary.shownCount).toBe(2)
    expect(summary.hiddenCount).toBe(2)
    expect(summary.queryHits.map(m => m.id)).toEqual([1])
    expect(summary.roleCounts[0]).toEqual({ role: 'Button', count: 2 })
    expect(summary.tiles.length).toBeGreaterThan(0)
  })
})
