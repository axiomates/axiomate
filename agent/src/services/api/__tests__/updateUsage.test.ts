import { describe, it, expect } from 'vitest'
import { updateUsage, accumulateUsage } from '../usageUtils.js'
import { EMPTY_USAGE } from '../emptyUsage.js'
import type { NonNullableUsage } from '../../../entrypoints/sdk/sdkUtilityTypes.js'

// Helper to create a usage object with specific overrides (deep copy to avoid mutation)
function usage(overrides: Partial<NonNullableUsage> = {}): NonNullableUsage {
  return {
    ...EMPTY_USAGE,
    server_tool_use: { ...EMPTY_USAGE.server_tool_use },
    cache_creation: { ...EMPTY_USAGE.cache_creation },
    iterations: [...EMPTY_USAGE.iterations],
    ...overrides,
  }
}

// Helper to create a partial usage delta (as received from stream events)
function partUsage(overrides: Record<string, unknown> = {}): any {
  return {
    output_tokens: 0,
    ...overrides,
  }
}

describe('updateUsage', () => {
  it('returns a copy of usage when partUsage is undefined', () => {
    const original = usage({ input_tokens: 100 })
    const result = updateUsage(original, undefined)
    expect(result).toEqual(original)
    expect(result).not.toBe(original) // must be a new object
  })

  it('does not mutate the original usage object', () => {
    const original = usage({ input_tokens: 100 })
    const frozen = Object.freeze({ ...original })
    // should not throw even though original is frozen-like
    const result = updateUsage(frozen, partUsage({ input_tokens: 200 }))
    expect(result.input_tokens).toBe(200)
  })

  describe('input_tokens', () => {
    it('updates when partUsage.input_tokens > 0', () => {
      const result = updateUsage(
        usage({ input_tokens: 50 }),
        partUsage({ input_tokens: 200 }),
      )
      expect(result.input_tokens).toBe(200)
    })

    it('does NOT overwrite when partUsage.input_tokens === 0', () => {
      const result = updateUsage(
        usage({ input_tokens: 50 }),
        partUsage({ input_tokens: 0 }),
      )
      expect(result.input_tokens).toBe(50)
    })

    it('does NOT overwrite when partUsage.input_tokens === null', () => {
      const result = updateUsage(
        usage({ input_tokens: 50 }),
        partUsage({ input_tokens: null }),
      )
      expect(result.input_tokens).toBe(50)
    })
  })

  describe('output_tokens', () => {
    it('updates with new value (no > 0 guard)', () => {
      const result = updateUsage(
        usage({ output_tokens: 10 }),
        partUsage({ output_tokens: 50 }),
      )
      expect(result.output_tokens).toBe(50)
    })

    it('preserves old value when partUsage.output_tokens is undefined', () => {
      const result = updateUsage(
        usage({ output_tokens: 10 }),
        partUsage({ output_tokens: undefined }),
      )
      expect(result.output_tokens).toBe(10)
    })

    it('CAN overwrite with 0 (differs from input_tokens behavior)', () => {
      const result = updateUsage(
        usage({ output_tokens: 10 }),
        partUsage({ output_tokens: 0 }),
      )
      expect(result.output_tokens).toBe(0)
    })
  })

  describe('cache_creation_input_tokens', () => {
    it('updates when > 0', () => {
      const result = updateUsage(
        usage({ cache_creation_input_tokens: 0 }),
        partUsage({ cache_creation_input_tokens: 100 }),
      )
      expect(result.cache_creation_input_tokens).toBe(100)
    })

    it('does NOT overwrite when === 0', () => {
      const result = updateUsage(
        usage({ cache_creation_input_tokens: 100 }),
        partUsage({ cache_creation_input_tokens: 0 }),
      )
      expect(result.cache_creation_input_tokens).toBe(100)
    })

    it('does NOT overwrite when === null', () => {
      const result = updateUsage(
        usage({ cache_creation_input_tokens: 100 }),
        partUsage({ cache_creation_input_tokens: null }),
      )
      expect(result.cache_creation_input_tokens).toBe(100)
    })
  })

  describe('cache_read_input_tokens', () => {
    it('updates when > 0', () => {
      const result = updateUsage(
        usage({ cache_read_input_tokens: 0 }),
        partUsage({ cache_read_input_tokens: 500 }),
      )
      expect(result.cache_read_input_tokens).toBe(500)
    })

    it('does NOT overwrite when === 0', () => {
      const result = updateUsage(
        usage({ cache_read_input_tokens: 500 }),
        partUsage({ cache_read_input_tokens: 0 }),
      )
      expect(result.cache_read_input_tokens).toBe(500)
    })
  })

  describe('server_tool_use', () => {
    it('updates web_search_requests when present', () => {
      const result = updateUsage(
        usage(),
        partUsage({ server_tool_use: { web_search_requests: 3 } }),
      )
      expect(result.server_tool_use.web_search_requests).toBe(3)
    })

    it('preserves old value when partUsage has no server_tool_use', () => {
      const base = usage()
      base.server_tool_use.web_search_requests = 5
      const result = updateUsage(base, partUsage({}))
      expect(result.server_tool_use.web_search_requests).toBe(5)
    })
  })

  describe('service_tier', () => {
    it('always preserves the original value', () => {
      const result = updateUsage(
        usage({ service_tier: 'standard' }),
        partUsage({ service_tier: 'priority' }),
      )
      expect(result.service_tier).toBe('standard')
    })
  })

  describe('cache_creation (ephemeral)', () => {
    it('updates ephemeral_1h when present in partUsage', () => {
      const result = updateUsage(
        usage(),
        partUsage({
          cache_creation: { ephemeral_1h_input_tokens: 42 },
        }),
      )
      expect(result.cache_creation.ephemeral_1h_input_tokens).toBe(42)
    })

    it('preserves old value when not in partUsage', () => {
      const base = usage()
      base.cache_creation.ephemeral_5m_input_tokens = 99
      const result = updateUsage(base, partUsage({}))
      expect(result.cache_creation.ephemeral_5m_input_tokens).toBe(99)
    })
  })
})

describe('accumulateUsage', () => {
  it('adds token counts from both usages', () => {
    const total = usage({ input_tokens: 100, output_tokens: 50 })
    const msg = usage({ input_tokens: 200, output_tokens: 30 })
    const result = accumulateUsage(total, msg)
    expect(result.input_tokens).toBe(300)
    expect(result.output_tokens).toBe(80)
  })

  it('adds cache tokens', () => {
    const total = usage({
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 20,
    })
    const msg = usage({
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 15,
    })
    const result = accumulateUsage(total, msg)
    expect(result.cache_creation_input_tokens).toBe(15)
    expect(result.cache_read_input_tokens).toBe(35)
  })

  it('adds server_tool_use counts', () => {
    const total = usage()
    total.server_tool_use.web_search_requests = 2
    const msg = usage()
    msg.server_tool_use.web_search_requests = 3
    const result = accumulateUsage(total, msg)
    expect(result.server_tool_use.web_search_requests).toBe(5)
  })

  it('uses most recent service_tier from message', () => {
    const total = usage({ service_tier: 'standard' })
    const msg = usage({ service_tier: 'priority' as any })
    const result = accumulateUsage(total, msg)
    expect(result.service_tier).toBe('priority')
  })

  it('adds ephemeral cache creation tokens', () => {
    const total = usage()
    total.cache_creation.ephemeral_1h_input_tokens = 10
    const msg = usage()
    msg.cache_creation.ephemeral_1h_input_tokens = 5
    const result = accumulateUsage(total, msg)
    expect(result.cache_creation.ephemeral_1h_input_tokens).toBe(15)
  })
})
