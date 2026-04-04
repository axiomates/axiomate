// Stub: Spinner types — type-only imports from useCancelRequest, useRemoteSession, handlePromptSubmit.

export type SpinnerMode =
  | 'thinking'
  | 'tool'
  | 'tool-use'
  | 'tool-input'
  | 'waiting'
  | 'idle'
  | 'requesting'
  | 'responding'
  | 'cancelling'
  | 'streaming'

export type RGBColor = { r: number; g: number; b: number }

export type RemotePermissionResponse = {
  behavior: 'allow' | 'deny'
  toolName?: string
}

export interface RemoteSessionConfig {
  sessionId: string
  url: string
}

export class RemoteSessionManager {
  config: RemoteSessionConfig
  constructor(config: RemoteSessionConfig) {
    this.config = config
  }
  connect(): void {
    // no-op
  }
  disconnect(): void {
    // no-op
  }
}

export function useShimmerAnimation(): {
  color: RGBColor
  frame: string
} {
  return { color: { r: 255, g: 255, b: 255 }, frame: '' }
}

export function useNotifications(): {
  notifications: never[]
  addNotification: (..._args: unknown[]) => void
  removeNotification: (..._args: unknown[]) => void
} {
  return {
    notifications: [],
    addNotification() {},
    removeNotification() {},
  }
}

export function expandPastedTextRefs(
  input: string,
  _pastedContents: Record<string, unknown>,
): string {
  return input
}

export function parseReferences(
  _input: string,
): Array<{ id: string; type: string }> {
  return []
}
