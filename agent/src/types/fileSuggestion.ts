/**
 * Input type for the fileSuggestion hook command.
 *
 * Extends the base hook input (session_id, transcript_path, cwd, etc.)
 * with the user's partial path query.
 */

export type FileSuggestionCommandInput = {
  // Base hook fields
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string

  // File suggestion specific
  query: string
}
