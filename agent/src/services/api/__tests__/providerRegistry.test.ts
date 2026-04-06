import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock transitive deps of providerRegistry (it imports AnthropicProvider)
vi.mock('../../../services/analytics/index.js', () => ({ logEvent: vi.fn() }))
vi.mock('../withRetry.js', () => ({
  withRetry: vi.fn(async function* (_getClient: any, operation: any, options: any) {
    const client = await _getClient()
    const result = await operation(client, 1, { model: options.model, thinkingConfig: options.thinkingConfig, fastMode: options.fastMode })
    return result
  }),
  CannotRetryError: class extends Error {},
}))
vi.mock('../../../utils/diagLogs.js', () => ({ logForDiagnosticsNoPII: vi.fn() }))
vi.mock('../../../utils/betas.js', () => ({ getModelBetas: vi.fn().mockReturnValue([]) }))
vi.mock('../../../utils/model/model.js', () => ({
  getSmallFastModel: vi.fn().mockReturnValue('claude-haiku-4-5-20251001'),
  normalizeModelStringForAPI: vi.fn((m: string) => m),
}))
vi.mock('../claude.js', () => ({
  getAPIMetadata: vi.fn().mockReturnValue({}),
  getExtraBodyParams: vi.fn().mockReturnValue({}),
  adjustParamsForNonStreaming: vi.fn((p: any) => p),
  MAX_NON_STREAMING_TOKENS: 64000,
}))
vi.mock('../../../utils/log.js', () => ({ logError: vi.fn() }))
vi.mock('../../../utils/modelCost.js', () => ({ calculateUSDCost: vi.fn().mockReturnValue(0) }))

import { getProviderForModel, registerProvider, unregisterProvider } from '../providerRegistry.js'
import type { LLMProvider } from '../provider.js'

function createMockProvider(name = 'test'): LLMProvider {
  return {
    name,
    bind: vi.fn().mockReturnValue({ createStream: vi.fn() }),
    createStream: vi.fn() as any,
    classifyError: vi.fn().mockReturnValue({ retryable: false, type: 'other' }),
    calculateCost: vi.fn().mockReturnValue(null),
    wrapError: vi.fn(),
    inference: vi.fn().mockResolvedValue({ id: '', content: [], model: '', stopReason: null, usage: { inputTokens: 0, outputTokens: 0 } }),
    countTokens: vi.fn().mockResolvedValue(null),
  }
}

describe('providerRegistry', () => {
  beforeEach(() => {
    // Clean up any registered providers between tests
    unregisterProvider('test')
    unregisterProvider('openai')
  })

  it('returns default anthropic provider for standard model', () => {
    const provider = getProviderForModel('claude-opus-4-6')
    expect(provider.name).toBe('anthropic')
  })

  it('registerProvider with wildcard pattern matches model', () => {
    const mockProvider = createMockProvider()
    registerProvider('test', mockProvider, ['test-*'])
    expect(getProviderForModel('test-model')).toBe(mockProvider)
  })

  it('exact match: registered pattern matches only that model', () => {
    const mockProvider = createMockProvider()
    registerProvider('test', mockProvider, ['exact-model'])
    expect(getProviderForModel('exact-model')).toBe(mockProvider)
    // Other models fall back to default
    expect(getProviderForModel('other-model').name).toBe('anthropic')
  })

  it('unregisterProvider causes fallback to default', () => {
    const mockProvider = createMockProvider()
    registerProvider('test', mockProvider, ['test-*'])
    expect(getProviderForModel('test-model')).toBe(mockProvider)

    unregisterProvider('test')
    expect(getProviderForModel('test-model').name).toBe('anthropic')
  })

  it('multiple patterns: both match', () => {
    const mockProvider = createMockProvider('openai')
    registerProvider('openai', mockProvider, ['gpt-*', 'o1-*'])
    expect(getProviderForModel('gpt-4o')).toBe(mockProvider)
    expect(getProviderForModel('o1-preview')).toBe(mockProvider)
    // Non-matching still falls back
    expect(getProviderForModel('claude-opus-4-6').name).toBe('anthropic')
  })
})
