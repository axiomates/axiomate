import type { UUID } from 'crypto'
import { randomUUID } from 'crypto'
import { validateUuid } from './uuid.js'

export type ParsedSessionUrl = {
  sessionId: UUID
  jsonlFile: string | null
  isJsonlFile: boolean
}

/**
 * Parse a session resume identifier. Accepted forms:
 * - Path ending in `.jsonl` — explicit transcript file to load
 * - A UUID — session ID to look up under the current project
 *
 * Returns null for any other input.
 */
export function parseSessionIdentifier(
  resumeIdentifier: string,
): ParsedSessionUrl | null {
  // Check for JSONL file path before UUID parsing so Windows absolute paths
  // (C:\path\file.jsonl) aren't misread.
  if (resumeIdentifier.toLowerCase().endsWith('.jsonl')) {
    return {
      sessionId: randomUUID() as UUID,
      jsonlFile: resumeIdentifier,
      isJsonlFile: true,
    }
  }

  if (validateUuid(resumeIdentifier)) {
    return {
      sessionId: resumeIdentifier as UUID,
      jsonlFile: null,
      isJsonlFile: false,
    }
  }

  return null
}
