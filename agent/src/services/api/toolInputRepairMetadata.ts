import type { ToolUseBlock } from './streamTypes.js'

const unparsedToolInputByBlock = new WeakMap<ToolUseBlock, string>()

export function rememberUnparsedToolInputForRepair(
  block: ToolUseBlock,
  unparsedInput: string,
): void {
  unparsedToolInputByBlock.set(block, unparsedInput)
}

export function getUnparsedToolInputForRepair(
  block: ToolUseBlock,
): string | undefined {
  return unparsedToolInputByBlock.get(block)
}
