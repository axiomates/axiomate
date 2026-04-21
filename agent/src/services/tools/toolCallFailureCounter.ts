/**
 * Counts how many times a given tool has returned an InputValidationError
 * tool_result in the recent message history, resetting on any non-error
 * tool_result for the same tool.
 *
 * Used by toolExecution.ts to escalate hint strength when the model loops
 * on the same malformed call: a first failure gets a normal schema error;
 * 2+ consecutive failures add a terse "pay attention to the schema" hint;
 * 4+ consecutive failures add a stop-and-re-read-the-schema warning.
 *
 * Stateless — derives the count purely from `messages`, so it works across
 * context clones (agent spawns, subagents) that might otherwise lose a
 * mutable counter.
 */
import type { Message } from '../../types/message.js'

const INPUT_VALIDATION_ERROR_MARKER = 'InputValidationError'

/**
 * Walks `messages` forward. For each user-side tool_result entry belonging
 * to a tool call of `toolName`, increment the consecutive-error counter if
 * the result contains `InputValidationError`; reset to zero on any other
 * tool_result for that tool. Returns the counter's terminal value.
 */
export function countConsecutiveInputValidationFailures(
  messages: readonly Message[],
  toolName: string,
): number {
  // Build tool_use_id → tool_name so we can attribute tool_results
  // (tool_results carry only the id, not the name).
  const idToName = new Map<string, string>()
  for (const m of messages) {
    if (m.type !== 'assistant') continue
    const content = m.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'tool_use' &&
        typeof (block as { id?: unknown }).id === 'string' &&
        typeof (block as { name?: unknown }).name === 'string'
      ) {
        idToName.set(
          (block as { id: string }).id,
          (block as { name: string }).name,
        )
      }
    }
  }

  let consecutive = 0
  for (const m of messages) {
    if (m.type !== 'user') continue
    const content = m.message.content
    if (!Array.isArray(content)) continue
    for (const c of content) {
      if (
        typeof c !== 'object' ||
        c === null ||
        !('type' in c) ||
        c.type !== 'tool_result'
      ) {
        continue
      }
      const toolUseId = (c as { tool_use_id?: unknown }).tool_use_id
      if (typeof toolUseId !== 'string') continue
      if (idToName.get(toolUseId) !== toolName) continue
      const resultContent = (c as { content?: unknown }).content
      const isError = (c as { is_error?: unknown }).is_error === true
      const isInputValidation =
        isError &&
        typeof resultContent === 'string' &&
        resultContent.includes(INPUT_VALIDATION_ERROR_MARKER)
      consecutive = isInputValidation ? consecutive + 1 : 0
    }
  }
  return consecutive
}
