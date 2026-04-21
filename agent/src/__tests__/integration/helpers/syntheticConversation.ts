/**
 * syntheticConversation — fluent builder for plausible Message[] fixtures.
 *
 * Used by integration tests that need a realistic-looking conversation
 * (proper UUIDs, timestamps, tool_use/tool_result pairing) but synthesized
 * from a declarative description rather than recorded from live use.
 *
 * Stub body — filled in when the first integration test needs it.
 */

export type SyntheticConversationBuilder = {
  // Planned API (example — actual shape will firm up with first use):
  //
  //   withUserMessage(text: string): this
  //   withAssistantMessage(text: string): this
  //   withToolCall(toolName: string, input: object, result: string): this
  //   withPendingTask(description: string): this   // pseudo: expressed as user ask
  //   withCompletedTask(description: string): this // pseudo: expressed as assistant done-confirmation
  //   build(): Message[]

  _placeholder: true
}

export function buildSyntheticConversation(): SyntheticConversationBuilder {
  throw new Error(
    'buildSyntheticConversation: not yet implemented — ' +
      'fill in when the first integration test needs synthetic Message[]. ' +
      'Generates proper UUIDs, timestamps, tool_use/tool_result pairing.',
  )
}
