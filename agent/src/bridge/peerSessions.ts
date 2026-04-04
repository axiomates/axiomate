// Stub: peerSessions — loaded behind require() in SendMessageTool.ts.
export async function postInterClaudeMessage(
  _target: unknown,
  _message: string,
): Promise<{ ok: boolean; error?: string }> {
  return { ok: false, error: 'Peer sessions not available in this build' }
}
