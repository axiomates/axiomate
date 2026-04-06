import { describe, it, expect, vi, beforeEach } from 'vitest'

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

import { AnthropicProvider } from '../providers/anthropicProvider.js'
import { withRetry } from '../withRetry.js'
import { getModelBetas } from '../../../utils/betas.js'
import { getAPIMetadata, getExtraBodyParams } from '../claude.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockClient() {
  return {
    beta: {
      messages: {
        create: vi.fn().mockResolvedValue({ id: 'msg_test', content: [], usage: {} }),
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnthropicProvider.verifyConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns true on success', async () => {
    const mockClient = createMockClient()
    const provider = new AnthropicProvider({
      getClient: vi.fn().mockResolvedValue(mockClient),
    })

    const result = await provider.verifyConnection({})
    expect(result).toBe(true)
  })

  it('calls create with correct params (model, max_tokens:1, temperature:1)', async () => {
    const mockClient = createMockClient()
    const provider = new AnthropicProvider({
      getClient: vi.fn().mockResolvedValue(mockClient),
    })

    await provider.verifyConnection({})

    expect(mockClient.beta.messages.create).toHaveBeenCalledTimes(1)
    const params = mockClient.beta.messages.create.mock.calls[0][0]
    expect(params.model).toBe('claude-haiku-4-5-20251001')
    expect(params.max_tokens).toBe(1)
    expect(params.temperature).toBe(1)
    expect(params.messages).toEqual([{ role: 'user', content: 'test' }])
  })

  it('calls getModelBetas', async () => {
    const mockClient = createMockClient()
    const provider = new AnthropicProvider({
      getClient: vi.fn().mockResolvedValue(mockClient),
    })

    await provider.verifyConnection({})
    expect(getModelBetas).toHaveBeenCalled()
  })

  it('calls getAPIMetadata', async () => {
    const mockClient = createMockClient()
    const provider = new AnthropicProvider({
      getClient: vi.fn().mockResolvedValue(mockClient),
    })

    await provider.verifyConnection({})
    expect(getAPIMetadata).toHaveBeenCalled()
  })

  it('calls getExtraBodyParams', async () => {
    const mockClient = createMockClient()
    const provider = new AnthropicProvider({
      getClient: vi.fn().mockResolvedValue(mockClient),
    })

    await provider.verifyConnection({})
    expect(getExtraBodyParams).toHaveBeenCalled()
  })

  it('passes maxRetries:2 to withRetry options', async () => {
    const mockClient = createMockClient()
    const provider = new AnthropicProvider({
      getClient: vi.fn().mockResolvedValue(mockClient),
    })

    await provider.verifyConnection({})

    const mockWithRetry = vi.mocked(withRetry)
    expect(mockWithRetry).toHaveBeenCalledTimes(1)
    const retryOptions = mockWithRetry.mock.calls[0][2] as unknown as Record<string, unknown>
    expect(retryOptions.maxRetries).toBe(2)
  })
})
