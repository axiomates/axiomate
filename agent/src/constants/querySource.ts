/**
 * QuerySource -- discriminates the origin / purpose of an API query.
 *
 * Used by retry logic, caching, analytics, and prompt-category helpers to
 * decide how to handle a given request.
 */
export type QuerySource =
  // Main REPL thread
  | 'repl_main_thread'
  | `repl_main_thread:outputStyle:${string}`
  // SDK
  | 'sdk'
  // Agents
  | 'agent:custom'
  | 'agent:default'
  | 'agent:builtin'
  | `agent:builtin:${string}`
  // Compact / summary
  | 'compact'
  | 'compact:urgent'
  | 'compact:pre'
  | 'compact:micro'
  // Background / auxiliary
  | 'title_generation'
  | 'prompt_suggestion'
  | 'yolo_classifier'
  | 'auto_mode'
  | 'hook_agent'
  | 'hook_prompt'
  | 'verification_agent'
  | 'side_question'
  // Catch-all for forward compatibility
  | (string & {})
