// Spinner type stubs — imported for type-only use by spinner callers.

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
