import type { NonNullableUsage } from '../../entrypoints/sdk/sdkUtilityTypes.js'

/**
 * Anthropic-specific zero-initialized usage object (NonNullableUsage format).
 * Used by Anthropic Provider path code (llm.ts, QueryEngine, logging).
 *
 * NOT used by the protocol-neutral layer (processStream has its own
 * neutral EMPTY_USAGE with { inputTokens: 0, outputTokens: 0 }).
 *
 * Contains Anthropic-specific fields: server_tool_use, service_tier,
 * inference_geo, iterations, speed. OpenAI Provider would not use this.
 */
export const EMPTY_USAGE: Readonly<NonNullableUsage> = {
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: 'standard',
  cache_creation: {
    ephemeral_1h_input_tokens: 0,
    ephemeral_5m_input_tokens: 0,
  },
  inference_geo: '',
  iterations: [],
  speed: 'standard',
}
