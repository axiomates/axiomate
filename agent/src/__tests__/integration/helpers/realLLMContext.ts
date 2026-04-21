/**
 * realLLMContext — helper for integration tests that call axiomate core
 * functions (compactConversation, runToolUse, etc.) against a REAL LLM.
 *
 * Resolves the test model via config/testModels.ts + the user's
 * ~/.axiomate.json "models" map. Returns a minimal ToolUseContext plus
 * whatever glue the caller needs to invoke the target function.
 *
 * Stub body — filled in when the first real-LLM integration test lands.
 * This file exists now so the framework has its type shape documented.
 */
import type { TestModelCategory } from '../config/testModels.js'

export type RealLLMHarness = {
  // Fields filled in when we learn what a test actually needs:
  //   context: ToolUseContext
  //   cacheSafeParams: CacheSafeParams
  //   modelName: string
  //   abortController: AbortController
  //   dispose(): Promise<void>
  //
  // Intentionally empty for now — adding fields prematurely ties the API
  // to assumptions that may not survive the first real test.
  _placeholder: true
}

export async function createRealLLMContext(_params: {
  category: TestModelCategory
  tools?: readonly unknown[]
  abortSignal?: AbortSignal
}): Promise<RealLLMHarness> {
  throw new Error(
    'createRealLLMContext: not yet implemented — ' +
      'fill in when the first real-LLM integration test is written. ' +
      'Expected to wire getGlobalConfig().models[TEST_MODELS[category]] ' +
      'into a minimal ToolUseContext.',
  )
}
