import type { Message } from '../../types/message.js'
import { getKnownTokenUsage, getTokenCountFromUsage } from '../../utils/tokens.js'

export function getLastKnownAgentUsage(messages: Message[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    const usage = message ? getKnownTokenUsage(message) : undefined
    if (usage) {
      return usage
    }
  }
  return undefined
}

export function getLastKnownAgentTokenCount(messages: Message[]): number {
  const usage = getLastKnownAgentUsage(messages)
  return usage ? getTokenCountFromUsage(usage) : 0
}
