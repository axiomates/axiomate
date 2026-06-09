/**
 * Integration test model registry — lives inside the test folder.
 *
 * Each entry names a model by its key in the user's ~/.axiomate.json
 * "models" map. Tests read credentials from that user config at runtime
 * (via getGlobalConfig()). This file only declares WHICH model each test
 * category uses — centralized decision point for cost/capability
 * trade-offs, so API choices don't scatter across env vars.
 *
 * Add a new category here when introducing a test type with different
 * requirements (e.g., vision-capable, large-context, reasoning).
 */
export const TEST_MODELS = {
  /**
   * Cheap small model for summarization / compact tests.
   * Qwen3 8B via SiliconFlow is free tier (subject to rate limits).
   * Small-model bar: if Qwen3 8B obeys our prompt, larger models will too.
   */
  summarization: 'Qwen/Qwen3-8B',

  /**
   * Tool-calling-capable model for runtime dispatch tests that need the
   * model to emit structured tool_use (not just text). 8B tool-calling
   * may be too weak; bump to 32B if empirically unstable.
   */
  toolCalling: 'Qwen/Qwen3-8B',

  /**
   * Fallback target for the route/auxiliary fallback gate. The gate points an
   * unavailable primary at this model and asserts recovery switches to it, so
   * it must be a real, reachable, low-cost model — NOT the expensive main
   * model. A mid-size Qwen on SiliconFlow is cheap and reliable enough to be
   * the thing we fall back TO.
   */
  fallbackTarget: 'Qwen/Qwen3.5-122B-A10B',
} as const

export type TestModelCategory = keyof typeof TEST_MODELS
