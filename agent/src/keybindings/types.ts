// Stub: keybinding types — imported by PermissionPrompt, useExitOnCtrlCD, etc.

export type KeybindingAction = string

export type KeybindingContextName = string

export interface ParsedKeystroke {
  key: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  alt?: boolean
  super?: boolean
}

export type Chord = ParsedKeystroke[]

export interface KeybindingBlock {
  context: KeybindingContextName
  bindings: Record<string, KeybindingAction>
}

export interface ParsedBinding {
  chord: Chord
  action: KeybindingAction
  context: KeybindingContextName
}

export function useDoublePress(
  _onSinglePress: () => void,
  _onDoublePress: () => void,
  _timeout?: number,
): (event?: unknown) => void {
  return () => {}
}

export function checkDuplicateKeysInJson(
  _content: string,
): KeybindingWarning[] {
  return []
}

export type KeybindingWarning = {
  message: string
  severity: 'warning' | 'error'
}

export function validateBindings(
  _userBlocks: KeybindingBlock[],
  _mergedBindings: unknown,
): KeybindingWarning[] {
  return []
}
