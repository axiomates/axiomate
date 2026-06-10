import {
  expandPastedTextRefs,
  formatPastedTextRef,
  getPastedTextRefNumLines,
} from '../history.js'
import instances from '../ink/instances.js'
import type { PastedContent } from './config.js'
import { classifyGuiEditor, getExternalEditor, withGuiWaitFlag } from './editor.js'
import { logForDebugging } from './debug.js'
import { execSync_DEPRECATED } from './execSyncWrapper.js'
import { getFsImplementation } from './fsOperations.js'
import { toIDEDisplayName } from './ide.js'
import { writeFileSync_DEPRECATED } from './slowOperations.js'
import { generateTempFilePath } from './tempfile.js'
import type { z } from 'zod'

function isGuiEditor(editor: string): boolean {
  return classifyGuiEditor(editor) !== undefined
}

export type EditorResult = {
  content: string | null
  error?: string
}

// sync IO: called from sync context (React components, sync command handlers)
export function editFileInEditor(filePath: string): EditorResult {
  const fs = getFsImplementation()
  const inkInstance = instances.get(process.stdout)
  if (!inkInstance) {
    throw new Error('Ink instance not found - cannot pause rendering')
  }

  const editor = getExternalEditor()
  if (!editor) {
    // No editor found. On POSIX this means none of $VISUAL/$EDITOR/code/vi/nano
    // resolved (Windows always has the notepad fallback). Detail goes to the
    // debug log only; the user-facing surface stays terse and is the caller's
    // job. `error` lets the caller distinguish "no editor" from a clean
    // null (cancel / unchanged) without leaking specifics into the UI.
    logForDebugging(
      `editFileInEditor: no editor available (platform=${process.platform}, ` +
        `$VISUAL=${process.env.VISUAL ?? ''}, $EDITOR=${process.env.EDITOR ?? ''}); ` +
        `set $EDITOR or install code/vi/nano`,
      { level: 'warn' },
    )
    return {
      content: null,
      error: 'No text editor found. Set the $EDITOR environment variable.',
    }
  }

  try {
    fs.statSync(filePath)
  } catch {
    return { content: null }
  }

  const useAlternateScreen = !isGuiEditor(editor)

  if (useAlternateScreen) {
    // Terminal editors (vi, nano, etc.) take over the terminal. Delegate to
    // Ink's alt-screen-aware handoff so fullscreen mode (where <AlternateScreen>
    // already entered alt screen) doesn't get knocked back to the main buffer
    // by a hardcoded ?1049l. enterAlternateScreen() internally calls pause()
    // and suspendStdin(); exitAlternateScreen() undoes both and resets frame
    // state so the next render writes from scratch.
    inkInstance.enterAlternateScreen()
  } else {
    // GUI editors (code, subl, etc.) open in a separate window — just pause
    // Ink and release stdin while they're open.
    inkInstance.pause()
    inkInstance.suspendStdin()
  }

  try {
    // Append the GUI family's wait flag so a fork-and-exit GUI editor blocks
    // until the file is closed (otherwise the sync spawn returns and we read
    // back the file before the user edits it). Terminal editors pass through.
    const editorCommand = withGuiWaitFlag(editor)
    execSync_DEPRECATED(`${editorCommand} "${filePath}"`, {
      stdio: 'inherit',
    })

    // Read the edited content
    const editedContent = fs.readFileSync(filePath, { encoding: 'utf-8' })
    return { content: editedContent }
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'status' in err &&
      typeof (err as { status: unknown }).status === 'number'
    ) {
      const status = (err as { status: number }).status
      if (status !== 0) {
        const editorName = toIDEDisplayName(editor)
        return {
          content: null,
          error: `${editorName} exited with code ${status}`,
        }
      }
    }
    return { content: null }
  } finally {
    if (useAlternateScreen) {
      inkInstance.exitAlternateScreen()
    } else {
      inkInstance.resumeStdin()
      inkInstance.resume()
    }
  }
}

/**
 * Re-collapse expanded pasted text by finding content that matches
 * pastedContents and replacing it with references.
 */
function recollapsePastedContent(
  editedPrompt: string,
  originalPrompt: string,
  pastedContents: Record<number, PastedContent>,
): string {
  let collapsed = editedPrompt

  // Find pasted content in the edited text and re-collapse it
  for (const [id, content] of Object.entries(pastedContents)) {
    if (content.type === 'text') {
      const pasteId = parseInt(id)
      const contentStr = content.content

      // Check if this exact content exists in the edited prompt
      const contentIndex = collapsed.indexOf(contentStr)
      if (contentIndex !== -1) {
        // Replace with reference
        const numLines = getPastedTextRefNumLines(contentStr)
        const ref = formatPastedTextRef(pasteId, numLines)
        collapsed =
          collapsed.slice(0, contentIndex) +
          ref +
          collapsed.slice(contentIndex + contentStr.length)
      }
    }
  }

  return collapsed
}

// sync IO: called from sync context (React components, sync command handlers)
export function editPromptInEditor(
  currentPrompt: string,
  pastedContents?: Record<number, PastedContent>,
): EditorResult {
  const fs = getFsImplementation()
  const tempFile = generateTempFilePath()

  try {
    // Expand any pasted text references before editing
    const expandedPrompt = pastedContents
      ? expandPastedTextRefs(currentPrompt, pastedContents)
      : currentPrompt

    // Write expanded prompt to temp file
    writeFileSync_DEPRECATED(tempFile, expandedPrompt, {
      encoding: 'utf-8',
      flush: true,
    })

    // Delegate to editFileInEditor
    const result = editFileInEditor(tempFile)

    if (result.content === null) {
      return result
    }

    // Trim a single trailing newline if present (common editor behavior)
    let finalContent = result.content
    if (finalContent.endsWith('\n') && !finalContent.endsWith('\n\n')) {
      finalContent = finalContent.slice(0, -1)
    }

    // Re-collapse pasted content if it wasn't edited
    if (pastedContents) {
      finalContent = recollapsePastedContent(
        finalContent,
        currentPrompt,
        pastedContents,
      )
    }

    return { content: finalContent }
  } finally {
    // Clean up temp file
    try {
      fs.unlinkSync(tempFile)
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Result of editing a JSON document in the user's $EDITOR.
 *
 * - `ok: true` — content parsed as JSON and passed Zod validation.
 * - `ok: false, cancelled: true` — user closed the editor without saving
 *   (content unchanged from initial). Caller should treat as a no-op.
 * - `ok: false, cancelled?: false` — content changed but failed JSON parse
 *   or schema validation. `error` is a human-readable, multi-line message
 *   suitable for showing in a TUI alongside [Re-edit]/[Cancel] options.
 *   `raw` holds the user's last-saved content so a Re-edit can preserve it.
 *   `tempPath` lets the caller hand the same file back to editFileInEditor
 *   for a Re-edit (initial content already on disk).
 */
export type EditJsonResult<T> =
  | { ok: true; value: T }
  | { ok: false; cancelled: true }
  | { ok: false; error: string; raw: string; tempPath: string }

export type EditJsonOptions<T> =
  | {
      mode?: 'fresh'
      /** Initial content written to the temp file before opening $EDITOR. */
      initialContent: string
      /** Zod schema; result.ok === true only when both JSON.parse and schema.safeParse pass. */
      schema: z.ZodSchema<T>
      /** Filename hint for the temp file (e.g. 'axiomate-template-foo'). Default: 'axiomate-edit'. */
      filenameHint?: string
    }
  | {
      mode: 'reuse'
      /** Existing temp file path to reuse (Re-edit flow). Editor reopens the user's typed content. */
      reusePath: string
      schema: z.ZodSchema<T>
    }

/**
 * Spawn $EDITOR with prefilled JSON, validate the result against a Zod schema.
 *
 * Sync because editFileInEditor is sync (Ink instance pause/resume requires
 * synchronous handoff). Cleans up the temp file on success, leaves it in
 * place on validation failure so the caller can offer a Re-edit by passing
 * the path back via `reusePath`.
 */
export function editJsonInEditor<T>(opts: EditJsonOptions<T>): EditJsonResult<T> {
  const fs = getFsImplementation()

  let tempPath: string
  let before: string
  if (opts.mode === 'reuse') {
    tempPath = opts.reusePath
    try {
      before = fs.readFileSync(opts.reusePath, { encoding: 'utf-8' })
    } catch {
      // Reuse path missing — treat as cancellation rather than crashing.
      return { ok: false, cancelled: true }
    }
  } else {
    tempPath = generateTempFilePath(
      opts.filenameHint ?? 'axiomate-edit',
      '.json',
    )
    before = opts.initialContent
    writeFileSync_DEPRECATED(tempPath, opts.initialContent, {
      encoding: 'utf-8',
      flush: true,
    })
  }

  const result = editFileInEditor(tempPath)
  if (result.content === null) {
    // Editor failed to launch or aborted — surface as cancellation; the
    // temp file may or may not exist, but cleaning up unconditionally is safe.
    cleanupTempFile(tempPath)
    return { ok: false, cancelled: true }
  }

  if (result.content === before) {
    // User closed editor without saving anything new.
    cleanupTempFile(tempPath)
    return { ok: false, cancelled: true }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(result.content)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: prettifyJsonError(message, result.content),
      raw: result.content,
      tempPath,
    }
  }

  const validation = opts.schema.safeParse(parsed)
  if (!validation.success) {
    const issues = validation.error.issues
      .map(i => `  • ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n')
    return {
      ok: false,
      error: `Schema validation failed:\n${issues}`,
      raw: result.content,
      tempPath,
    }
  }

  cleanupTempFile(tempPath)
  return { ok: true, value: validation.data }
}

function cleanupTempFile(path: string): void {
  try {
    getFsImplementation().unlinkSync(path)
  } catch {
    // Best-effort; the OS cleans /tmp eventually.
  }
}

/**
 * Translate V8's JSON.parse error message into a hint that explains the
 * likely cause and points at line/col instead of byte offset. The user
 * is editing in $EDITOR, so the goal is to make the most common JS-vs-JSON
 * confusions (comments, trailing commas, unquoted keys, single quotes,
 * special numerics) easy to spot at a glance. Falls back to the V8 message
 * if no pattern matches.
 *
 * Node's V8 error format varies by version (older: "at position N";
 * newer: "Unexpected token X, ..."), so we don't trust the position field
 * — we scan the content for the offending pattern ourselves and compute
 * line/col from the first match.
 */
export function prettifyJsonError(message: string, content: string): string {
  type Probe = { regex: RegExp; hint: string }
  const probes: Probe[] = [
    {
      regex: /\/\/[^\n]*|\/\*[\s\S]*?\*\//,
      hint: "JSON does not support comments. Remove '//' or '/* */' lines.",
    },
    {
      regex: /,\s*[}\]]/,
      hint: "JSON does not allow trailing commas. Remove the comma before '}' or ']'.",
    },
    {
      regex: /[{,]\s*([A-Za-z_$][\w$]*)\s*:/,
      hint: 'JSON requires keys to be double-quoted strings (not bare identifiers). Wrap them in "...".',
    },
    {
      regex: /:\s*'[^']*'/,
      hint: `JSON requires double quotes ", not single ' for strings.`,
    },
    {
      regex: /(?:^|[\s:,\[])(Infinity|NaN|undefined)\b/,
      hint: 'JSON does not support Infinity, NaN, or undefined. Use null or a finite number.',
    },
  ]

  for (const { regex, hint } of probes) {
    const m = regex.exec(content)
    if (m) {
      const { line, col } = linecolFromOffset(content, m.index)
      return `${hint} (line ${line}, col ${col})`
    }
  }

  // No specific pattern matched — try to extract a position from the raw
  // V8 message (older Node format) or just pass through.
  const posMatch = /at position (\d+)/.exec(message)
  if (posMatch) {
    const { line, col } = linecolFromOffset(
      content,
      Number.parseInt(posMatch[1]!, 10),
    )
    return `Invalid JSON at line ${line}, col ${col}: ${message}`
  }
  return `Invalid JSON: ${message}`
}

/** Convert a 0-based byte offset into 1-based line/col (counting LF). */
function linecolFromOffset(
  content: string,
  offset: number,
): { line: number; col: number } {
  let line = 1
  let col = 1
  const limit = Math.min(offset, content.length)
  for (let i = 0; i < limit; i++) {
    if (content[i] === '\n') {
      line++
      col = 1
    } else {
      col++
    }
  }
  return { line, col }
}
