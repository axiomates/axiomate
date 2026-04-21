/**
 * mockedProvider — LLMProvider stub that returns a canned response.
 *
 * For pipeline integration tests that need to verify multi-component
 * wiring (provider → stream accumulator → runToolUse → repair pipeline)
 * given a SPECIFIC response shape, without spending tokens on a real LLM.
 *
 * Example use case: verify that when the mocked provider returns a
 * tool_use block with an alias key (`file` instead of `file_path`), the
 * runtime Hungarian pipeline repairs it and dispatches with the correct
 * schema key.
 *
 * Stub body — the full LLMProvider interface has 7 required methods.
 * When a test needs this mock, fill in only the methods actually
 * exercised by that test; leave others as `throw new Error('not mocked')`.
 */
import type { LLMProvider } from '../../../services/api/provider.js'

export type MockedResponseConfig = {
  // Planned shape (example — actual fields confirmed when first use lands):
  //
  //   content: ContentBlockParam[]
  //   stopReason?: StopReason
  //   usage?: Usage
  //   streamDelayMs?: number  // to simulate slow providers

  _placeholder: true
}

export function createMockedProvider(_config: MockedResponseConfig): LLMProvider {
  throw new Error(
    'createMockedProvider: not yet implemented — ' +
      'fill in when the first pipeline integration test needs it. ' +
      'Implements LLMProvider with canned responses for compactConversation / ' +
      'runToolUse pipeline verification.',
  )
}
