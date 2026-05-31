import { dirname, sep } from 'path'
import { z } from 'zod/v4'
import { diagnosticTracker } from '../../services/diagnosticTracking.js'
import { clearDeliveredDiagnosticsForFile } from '../../services/lsp/LSPDiagnosticRegistry.js'
import { getLspServerManager } from '../../services/lsp/manager.js'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  discoverSkillDirsForPaths,
} from '../../skills/loadSkillsDir.js'
import type { ToolUseContext } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { countLinesChanged, getPatchForDisplay } from '../../utils/diff.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isENOENT } from '../../utils/errors.js'
import {
  getFileModificationTime,
  normalizeContentToLf,
  writeTextContent,
} from '../../utils/file.js'
import { logFileOperation } from '../../utils/fileOperationAnalytics.js'
import { fileStateHasFullContent } from '../../utils/fileStateCache.js'
import {
  noteFileWrite,
  wasFileModifiedAfterReadByAnotherContext,
  withFileStatePathLock,
} from '../../utils/fileStateRegistry.js'
import { readFileSyncWithMetadata } from '../../utils/fileRead.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import type { ToolUseDiff } from '../../utils/gitDiff.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import { expandPath } from '../../utils/path.js'
import {
  checkWritePermissionForTool,
  matchingRuleForInput,
} from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from '../FileEditTool/constants.js'
import { FILE_UNCHANGED_STUB } from '../FileReadTool/prompt.js'
import { gitDiffSchema, hunkSchema } from '../FileEditTool/types.js'
import { FILE_WRITE_TOOL_NAME, getWriteToolDescription } from './prompt.js'
import {
  getToolUseSummary,
  isResultTruncated,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  userFacingName,
} from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z
      .string()
      .describe(
        'The absolute path to the file to write (must be absolute, not relative)',
      ),
    content: z.string().describe('The content to write to the file'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    type: z
      .enum(['create', 'update'])
      .describe(
        'Whether a new file was created or an existing file was updated',
      ),
    filePath: z.string().describe('The path to the file that was written'),
    content: z.string().describe('The content that was written to the file'),
    structuredPatch: z
      .array(hunkSchema())
      .describe('Diff patch showing the changes'),
    originalFile: z
      .string()
      .nullable()
      .describe(
        'The original file content before the write (null for new files)',
      ),
    gitDiff: gitDiffSchema().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>
export type FileWriteToolInput = InputSchema

function isInternalFileStatusText(content: string): boolean {
  const stripped = content.trim()
  if (!stripped) return false
  if (stripped === FILE_UNCHANGED_STUB) return true
  return (
    stripped.includes(FILE_UNCHANGED_STUB) &&
    stripped.length <= 2 * FILE_UNCHANGED_STUB.length
  )
}

export const FileWriteTool = buildTool({
  name: FILE_WRITE_TOOL_NAME,
  searchHint: 'create or overwrite files',
  maxResultSizeChars: 100_000,
  strict: true,
  async description() {
    return 'Write a file to the local filesystem.'
  },
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Writing ${summary}` : 'Writing file'
  },
  async prompt() {
    return getWriteToolDescription()
  },
  renderToolUseMessage,
  isResultTruncated,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  getPath(input): string {
    return input.file_path
  },
  backfillObservableInput(input) {
    // hooks.mdx documents file_path as absolute; expand so hook allowlists
    // can't be bypassed via ~ or relative paths.
    if (typeof input.file_path === 'string') {
      input.file_path = expandPath(input.file_path)
    }
  },
  async preparePermissionMatcher({ file_path }) {
    return pattern => matchWildcardPattern(pattern, file_path)
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkWritePermissionForTool(
      FileWriteTool,
      input,
      appState.toolPermissionContext,
    )
  },
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  extractSearchText() {
    // Transcript render shows either content (create, via HighlightedCode)
    // or a structured diff (update). The heuristic's 'content' allowlist key
    // would index the raw content string even in update mode where it's NOT
    // shown — phantom. Under-count: tool_use already indexes file_path.
    return ''
  },
  async validateInput({ file_path, content }, toolUseContext: ToolUseContext) {
    const fullFilePath = expandPath(file_path)

    if (isInternalFileStatusText(content)) {
      return {
        result: false,
        message:
          'Refusing to write internal Read status text as file content. Re-read the file or reconstruct the intended file contents before writing.',
        errorCode: 4,
      }
    }

    // Check if path should be ignored based on permission settings
    const appState = toolUseContext.getAppState()
    const denyRule = matchingRuleForInput(
      fullFilePath,
      appState.toolPermissionContext,
      'edit',
      'deny',
    )
    if (denyRule !== null) {
      return {
        result: false,
        message:
          'File is in a directory that is denied by your permission settings.',
        errorCode: 1,
      }
    }

    // SECURITY: Skip filesystem operations for UNC paths to prevent NTLM credential leaks.
    // On Windows, fs.existsSync() on UNC paths triggers SMB authentication which could
    // leak credentials to malicious servers. Let the permission check handle UNC paths.
    if (fullFilePath.startsWith('\\\\') || fullFilePath.startsWith('//')) {
      return { result: true }
    }

    const fs = getFsImplementation()
    let fileMtimeMs: number
    try {
      const fileStat = await fs.stat(fullFilePath)
      fileMtimeMs = fileStat.mtimeMs
    } catch (e) {
      if (isENOENT(e)) {
        return { result: true }
      }
      throw e
    }

    const readTimestamp = toolUseContext.readFileState.get(fullFilePath)
    if (!readTimestamp || readTimestamp.isPartialView) {
      return {
        result: false,
        message:
          'File has not been read yet. Read it first before writing to it.',
        errorCode: 2,
      }
    }

    if (wasFileModifiedAfterReadByAnotherContext(toolUseContext, fullFilePath)) {
      return {
        result: false,
        message:
          'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
        errorCode: 3,
      }
    }

    // Reuse mtime from the stat above — avoids a redundant statSync via
    // getFileModificationTime. The readTimestamp guard above ensures this
    // block is always reached when the file exists.
    const lastWriteTime = Math.floor(fileMtimeMs)
    if (lastWriteTime > readTimestamp.timestamp) {
      const meta = readFileSyncWithMetadata(fullFilePath)
      if (
        !fileStateHasFullContent(readTimestamp) ||
        meta.content !== readTimestamp.content
      ) {
        return {
          result: false,
          message:
            'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
          errorCode: 3,
        }
      }
    }

    return { result: true }
  },
  async call(
    { file_path, content },
    { readFileState, agentId, updateFileHistoryState, dynamicSkillDirTriggers },
    _,
    parentMessage,
  ) {
    if (isInternalFileStatusText(content)) {
      throw new Error(
        'Refusing to write internal Read status text as file content. Re-read the file or reconstruct the intended file contents before writing.',
      )
    }

    const fullFilePath = expandPath(file_path)
    const dir = dirname(fullFilePath)

    // Discover skills from this file's path (fire-and-forget, non-blocking)
    const cwd = getCwd()
    const newSkillDirs = await discoverSkillDirsForPaths([fullFilePath], cwd)
    if (newSkillDirs.length > 0) {
      // Store discovered dirs for attachment display
      for (const dir of newSkillDirs) {
        dynamicSkillDirTriggers?.add(dir)
      }
      // Don't await - let skill loading happen in the background
      addSkillDirectories(newSkillDirs).catch(() => {})
    }

    // Activate conditional skills whose path patterns match this file
    activateConditionalSkillsForPaths([fullFilePath], cwd)

    await diagnosticTracker.beforeFileEdited(fullFilePath)

    // Ensure parent directory exists before the atomic read-modify-write section.
    // Must stay OUTSIDE the critical section below (a yield between the staleness
    // check and writeTextContent lets concurrent edits interleave), and BEFORE the
    // write (lazy-mkdir-on-ENOENT would fire a spurious ax_atomic_write_error
    // inside writeFileSyncAndFlush_DEPRECATED before ENOENT propagates back).
    await getFsImplementation().mkdir(dir)

    const { oldContent, canonicalContent } = await withFileStatePathLock(
      fullFilePath,
      async () => {
        // Load current state and confirm no changes since last read.
        // Keep the final stale check and write in this same critical section.
        let meta: ReturnType<typeof readFileSyncWithMetadata> | null
        try {
          meta = readFileSyncWithMetadata(fullFilePath)
        } catch (e) {
          if (isENOENT(e)) {
            meta = null
          } else {
            throw e
          }
        }

        if (meta !== null) {
          const lastWriteTime = getFileModificationTime(fullFilePath)
          const lastRead = readFileState.get(fullFilePath)
          if (!lastRead || lastRead.isPartialView) {
            throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
          }
          if (
            wasFileModifiedAfterReadByAnotherContext(
              {
                agentId,
                readFileState,
              },
              fullFilePath,
            )
          ) {
            throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
          }
          if (lastWriteTime > lastRead.timestamp) {
            // Timestamp indicates modification, but on Windows timestamps can change
            // without content changes (cloud sync, antivirus, etc.). For full reads,
            // compare content as a fallback to avoid false positives.
            // meta.content is CRLF-normalized and BOM-stripped — matches Read state.
            if (
              !fileStateHasFullContent(lastRead) ||
              meta.content !== lastRead.content
            ) {
              throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
            }
          }
        }

        const oldContent = meta?.content ?? null
        const canonicalContent = normalizeContentToLf(content)

        // Write is full replacement, so it canonicalizes text instead of
        // preserving the overwritten file's encoding, BOM, or line-ending style.
        writeTextContent(fullFilePath, canonicalContent, 'utf8', 'LF')

        // Update read timestamp, to invalidate stale writes
        readFileState.set(fullFilePath, {
          content: canonicalContent,
          timestamp: getFileModificationTime(fullFilePath),
          offset: undefined,
          limit: undefined,
        })
        noteFileWrite({ agentId, readFileState }, fullFilePath)

        return { oldContent, canonicalContent }
      },
    )

    // Notify LSP servers about file modification (didChange) and save (didSave)
    const lspManager = getLspServerManager()
    if (lspManager) {
      // Clear previously delivered diagnostics so new ones will be shown
      clearDeliveredDiagnosticsForFile(`file://${fullFilePath}`)
      // didChange: Content has been modified
      lspManager
        .changeFile(fullFilePath, canonicalContent)
        .catch((err: Error) => {
          logForDebugging(
            `LSP: Failed to notify server of file change for ${fullFilePath}: ${err.message}`,
          )
          logError(err)
        })
      // didSave: File has been saved to disk (triggers diagnostics in TypeScript server)
      lspManager.saveFile(fullFilePath).catch((err: Error) => {
        logForDebugging(
          `LSP: Failed to notify server of file save for ${fullFilePath}: ${err.message}`,
        )
        logError(err)
      })
    }

    // Log when writing to AXIOMATE.md
    if (fullFilePath.endsWith(`${sep}AXIOMATE.md`)) {
    }

    const gitDiff: ToolUseDiff | undefined = undefined

    if (oldContent) {
      const patch = getPatchForDisplay({
        filePath: file_path,
        fileContents: oldContent,
        edits: [
          {
            old_string: oldContent,
            new_string: canonicalContent,
            replace_all: false,
          },
        ],
      })

      const data = {
        type: 'update' as const,
        filePath: file_path,
        content: canonicalContent,
        structuredPatch: patch,
        originalFile: oldContent,
        ...(gitDiff && { gitDiff }),
      }
      // Track lines added and removed for file updates, right before yielding result
      countLinesChanged(patch)

      logFileOperation({
        operation: 'write',
        tool: 'FileWriteTool',
        filePath: fullFilePath,
        type: 'update',
      })

      return {
        data,
      }
    }

    const data = {
      type: 'create' as const,
      filePath: file_path,
      content: canonicalContent,
      structuredPatch: [],
      originalFile: null,
      ...(gitDiff && { gitDiff }),
    }

    // For creation of new files, count all lines as additions, right before yielding the result
    countLinesChanged([], canonicalContent)

    logFileOperation({
      operation: 'write',
      tool: 'FileWriteTool',
      filePath: fullFilePath,
      type: 'create',
    })

    return {
      data,
    }
  },
  mapToolResultToToolResultBlockParam({ filePath, type }, toolUseID) {
    switch (type) {
      case 'create':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `File created successfully at: ${filePath}`,
        }
      case 'update':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `The file ${filePath} has been updated successfully.`,
        }
    }
  },
} satisfies ToolDef<InputSchema, Output>)
