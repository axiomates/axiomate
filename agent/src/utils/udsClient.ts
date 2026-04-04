// Stub: UDS client — loaded behind dynamic import/require in conversationRecovery.ts, SendMessageTool.ts.

export interface LiveSession {
  kind?: string
  sessionId?: string
  [key: string]: unknown
}

export async function listAllLiveSessions(): Promise<LiveSession[]> {
  return []
}

export async function sendToUdsSocket(
  _target: string,
  _message: string,
): Promise<void> {
  // no-op
}
