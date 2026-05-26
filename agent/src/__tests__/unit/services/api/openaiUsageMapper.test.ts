import { describe, expect, it } from 'vitest'
import { mapOpenAIUsage } from '../../../../services/api/adapters/openaiUsageMapper.js'

describe('mapOpenAIUsage', () => {
  it('maps basic OpenAI usage fields', () => {
    expect(
      mapOpenAIUsage({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 25,
          total_tokens: 125,
        },
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 25,
    })
  })

  it('maps DashScope-style prompt token details', () => {
    expect(
      mapOpenAIUsage({
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 50,
          total_tokens: 1050,
          prompt_tokens_details: {
            cached_tokens: 400,
            cache_creation: {
              cache_creation_input_tokens: 100,
            },
          },
        },
      }),
    ).toEqual({
      inputTokens: 500,
      outputTokens: 50,
      cacheReadTokens: 400,
      cacheWriteTokens: 100,
    })
  })

  it('maps SiliconFlow-style prompt cache hit and miss tokens', () => {
    expect(
      mapOpenAIUsage({
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 50,
          total_tokens: 1050,
          prompt_cache_hit_tokens: 300,
          prompt_cache_miss_tokens: 700,
        },
      }),
    ).toEqual({
      inputTokens: 700,
      outputTokens: 50,
      cacheReadTokens: 300,
    })
  })

  it('supports configured response paths with usage-relative shorthand', () => {
    expect(
      mapOpenAIUsage(
        {
          usage: {
            input: { total: '200', cached: '80' },
            output: { total: '10' },
          },
        },
        {
          promptTokens: 'input.total',
          completionTokens: 'output.total',
          cacheReadTokens: 'input.cached',
        },
      ),
    ).toEqual({
      inputTokens: 120,
      outputTokens: 10,
      cacheReadTokens: 80,
    })
  })
})
