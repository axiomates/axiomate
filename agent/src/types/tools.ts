/**
 * Tool progress types -- centralized to break import cycles.
 *
 * Each tool re-exports its own Progress type alias from here.
 */

// ============================================================================
// Base / shared
// ============================================================================

/** Discriminated union tag shared by all progress payloads. */
export type ToolProgressData =
  | BashProgress
  | PowerShellProgress
  | MCPProgress
  | SkillToolProgress
  | WebSearchProgress
  | AgentToolProgress
  | TaskOutputProgress
  | REPLToolProgress
  | REPLToolCallProgress

// ============================================================================
// Shell-family progress (Bash / PowerShell / generic shell)
// ============================================================================

export type BashProgress = {
  type: 'bash_progress'
  output: string
  fullOutput: string
  elapsedTimeSeconds: number
  totalLines: number
  totalBytes?: number
  timeoutMs?: number
  taskId?: string
}

export type PowerShellProgress = {
  type: 'powershell_progress'
  output: string
  fullOutput: string
  elapsedTimeSeconds: number
  totalLines: number
  totalBytes?: number
  timeoutMs?: number
  taskId?: string
}

/**
 * Unified shell progress -- used by BashModeProgress and AgentTool to display
 * sub-agent shell output without caring which backend produced it.
 */
export type ShellProgress = BashProgress | PowerShellProgress

// ============================================================================
// MCP tool progress
// ============================================================================

export type MCPProgress = {
  type: 'mcp_progress'
  message?: string
  [key: string]: unknown
}

// ============================================================================
// Skill tool progress
// ============================================================================

export type SkillToolProgress = {
  type: 'skill_progress'
  message: string
  [key: string]: unknown
}

// ============================================================================
// Web search progress
// ============================================================================

export type WebSearchProgress = {
  type: 'web_search_progress'
  message?: string
  [key: string]: unknown
}

// ============================================================================
// Agent tool progress
// ============================================================================

export type AgentToolProgress = {
  type: 'agent_progress'
  message: any
  [key: string]: unknown
}

// ============================================================================
// Task output progress
// ============================================================================

export type TaskOutputProgress = {
  type: 'task_output_progress'
  message?: string
  [key: string]: unknown
}

// ============================================================================
// REPL tool progress
// ============================================================================

export type REPLToolProgress = {
  type: 'repl_progress'
  message?: string
  [key: string]: unknown
}

export type REPLToolCallProgress = {
  type: 'repl_tool_call'
  phase: 'start' | 'end'
  toolName?: string
  toolInput?: Record<string, unknown>
  [key: string]: unknown
}

// ============================================================================
// SDK workflow progress (emitted via sdkEventQueue)
// ============================================================================

export type SdkWorkflowProgress = {
  tool_use_id?: string
  tool_name?: string
  status?: string
  [key: string]: unknown
}
