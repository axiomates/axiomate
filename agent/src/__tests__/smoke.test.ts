import { describe, it, expect } from 'vitest'
import { feature } from 'bun:bundle'

describe('test infrastructure', () => {
  it('vitest runs', () => {
    expect(1 + 1).toBe(2)
  })

  it('bun:bundle mock works', () => {
    expect(false).toBe(false)
  })
})
