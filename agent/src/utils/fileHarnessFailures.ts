export const FILE_HARNESS_FAILURE_REASONS = [
  'not_read',
  'partial_read_for_write',
  'stale_mtime',
  'stale_content',
  'sibling_write_after_read',
  'string_not_found',
  'multiple_match',
  'permission_denied',
  'atomic_write_failed',
  'encoding_unsupported',
] as const

export type FileHarnessFailureReason =
  (typeof FILE_HARNESS_FAILURE_REASONS)[number]

export type FileHarnessFailurePhase = 'validation' | 'execution' | 'helper'

export type FileHarnessFailureDisposition =
  | 'implemented'
  | 'planned'
  | 'documented'

export type FileHarnessFailureCatalogEntry = {
  reason: FileHarnessFailureReason
  description: string
  phases: readonly FileHarnessFailurePhase[]
  currentSignals: readonly string[]
  disposition: FileHarnessFailureDisposition
  stage6bAction: string
}

export const FILE_HARNESS_FAILURE_CATALOG = [
  {
    reason: 'not_read',
    description:
      'A structured write/edit targets an existing file that has no prior full-file or allowed partial read state in the current context.',
    phases: ['validation', 'execution'],
    currentSignals: [
      'FileEditTool validation errorCode 6',
      'FileWriteTool validation errorCode 2',
      'NotebookEditTool validation errorCode 9',
      'FILE_UNEXPECTEDLY_MODIFIED_ERROR thrown from final write section',
    ],
    disposition: 'implemented',
    stage6bAction:
      'Wrap execution-time misses with a typed failure while preserving current text.',
  },
  {
    reason: 'partial_read_for_write',
    description:
      'A full replacement write targets an existing file after only a partial read.',
    phases: ['validation', 'execution'],
    currentSignals: [
      'FileWriteTool validation errorCode 2 with readFileState.isPartialView',
      'FILE_UNEXPECTEDLY_MODIFIED_ERROR thrown from FileWriteTool call',
    ],
    disposition: 'implemented',
    stage6bAction:
      'Split this from not_read in typed metadata; keep current user-facing wording until UI mapping exists.',
  },
  {
    reason: 'stale_mtime',
    description:
      'The file mtime changed after the recorded read and the cached content is not sufficient to prove the write is still safe.',
    phases: ['validation', 'execution'],
    currentSignals: [
      'FileEditTool validation errorCode 7',
      'FileWriteTool validation errorCode 3',
      'NotebookEditTool validation errorCode 10',
      'FILE_UNEXPECTEDLY_MODIFIED_ERROR thrown from final write section',
    ],
    disposition: 'implemented',
    stage6bAction:
      'Classify stale failures at the exact branch that observes mtime drift.',
  },
  {
    reason: 'stale_content',
    description:
      'The mtime changed and the current normalized file content differs from the cached full-file read.',
    phases: ['validation', 'execution'],
    currentSignals: [
      'Same user-visible signals as stale_mtime after content fallback fails',
    ],
    disposition: 'implemented',
    stage6bAction:
      'Distinguish content mismatch from mtime-only drift in typed metadata.',
  },
  {
    reason: 'sibling_write_after_read',
    description:
      'Another in-process context wrote the path after this context read it.',
    phases: ['validation', 'execution'],
    currentSignals: [
      'wasFileModifiedAfterReadByAnotherContext returns true',
      'FileEditTool validation errorCode 7',
      'FileWriteTool validation errorCode 3',
      'NotebookEditTool validation errorCode 10',
      'FILE_UNEXPECTEDLY_MODIFIED_ERROR thrown from final write section',
    ],
    disposition: 'implemented',
    stage6bAction:
      'Attach registry writer/read sequence metadata to the typed failure.',
  },
  {
    reason: 'string_not_found',
    description:
      'A precise edit old_string does not occur in the current normalized file content.',
    phases: ['validation'],
    currentSignals: ['FileEditTool validation errorCode 8'],
    disposition: 'implemented',
    stage6bAction:
      'Map the existing validation result to a typed reason without changing message text.',
  },
  {
    reason: 'multiple_match',
    description:
      'A precise edit old_string occurs more than once and replace_all is false.',
    phases: ['validation'],
    currentSignals: ['FileEditTool validation errorCode 9'],
    disposition: 'implemented',
    stage6bAction:
      'Map the existing validation result to a typed reason without changing message text.',
  },
  {
    reason: 'permission_denied',
    description:
      'The path or command is blocked by the current file/shell permission policy.',
    phases: ['validation'],
    currentSignals: [
      'FileReadTool validation errorCode 1',
      'FileEditTool validation errorCode 2',
      'FileWriteTool validation errorCode 1',
      'PermissionDecision behavior deny',
    ],
    disposition: 'implemented',
    stage6bAction:
      'Keep permission subsystem as source of truth and add a file-harness mapping layer only.',
  },
  {
    reason: 'atomic_write_failed',
    description:
      'The same-directory temp write, chmod, cleanup, or rename path failed before a structured write completed.',
    phases: ['helper', 'execution'],
    currentSignals: [
      'writeFileSyncAndFlush_DEPRECATED rethrows the atomic filesystem error',
    ],
    disposition: 'implemented',
    stage6bAction:
      'Wrap helper failures with path, operation, errno code, and original cause.',
  },
  {
    reason: 'encoding_unsupported',
    description:
      'A file encoding cannot be safely decoded or round-tripped by the current text helpers.',
    phases: ['validation', 'execution'],
    currentSignals: [
      'No dedicated signal yet; current helpers only explicitly detect UTF-8 and UTF-16LE',
    ],
    disposition: 'planned',
    stage6bAction:
      'Add explicit detection or rejection before widening supported encodings.',
  },
] as const satisfies readonly FileHarnessFailureCatalogEntry[]

export function getFileHarnessFailureCatalogEntry(
  reason: FileHarnessFailureReason,
): FileHarnessFailureCatalogEntry {
  return FILE_HARNESS_FAILURE_CATALOG.find(entry => entry.reason === reason)!
}
