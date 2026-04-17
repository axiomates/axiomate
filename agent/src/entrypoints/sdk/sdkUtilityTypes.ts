/**
 * Anthropic-specific usage type with all fields non-nullable.
 *
 * This is the "storage" format used by llm.ts, QueryEngine, logging,
 * and cost tracking. It extends the basic token counts (input/output/cache)
 * with Anthropic-specific fields: server_tool_use, service_tier,
 * cache_creation breakdown, inference_geo, iterations, speed.
 *
 * The neutral stream layer uses a separate `Usage` type (camelCase, in
 * streamTypes.ts) with only the four core token fields.
 */

export type NonNullableUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  server_tool_use: {
    web_search_requests: number
    web_fetch_requests: number
  }
  service_tier: string
  cache_creation: {
    ephemeral_1h_input_tokens: number
    ephemeral_5m_input_tokens: number
  }
  inference_geo: string
  iterations: unknown[]
  speed: string
}

export const consumeInvokingRequestId: any = undefined as any;
