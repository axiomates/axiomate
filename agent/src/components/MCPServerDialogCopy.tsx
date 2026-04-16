import React from 'react'
import { Link, Text } from '../ink.js'

export function MCPServerDialogCopy(): React.ReactNode {
  return (
    <Text>
      MCP servers may execute code or access system resources. All tool calls
      require approval. Learn more in the{' '}
      <Link url="https://github.com/axiomates/axiomate/mcp">MCP documentation</Link>.
    </Text>
  )
}
