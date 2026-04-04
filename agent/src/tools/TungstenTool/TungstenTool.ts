// Stub: TungstenTool — Anthropic-internal tool, not available externally.
// Eagerly imported by tools.ts and ToolSelector.tsx; needs a Tool-shaped object.

import { z } from 'zod/v4'

export const TungstenTool = {
  name: 'tungsten' as const,
  aliases: [] as string[],
  inputSchema: z.object({}),
  async call() {
    return {
      type: 'result' as const,
      resultForAssistant: 'TungstenTool is not available in this build.',
      data: undefined,
    }
  },
  async description() {
    return 'TungstenTool (unavailable)'
  },
  isEnabled() {
    return false
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return true
  },
}

export function clearSessionsWithTungstenUsage(): void {
  // no-op
}

export function resetInitializationState(): void {
  // no-op
}
