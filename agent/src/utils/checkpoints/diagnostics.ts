import { isDebugMode, logForDebugging } from '../debug.js'

const CHECKPOINT_DIAGNOSTIC_PREFIX = '[checkpoint-diagnostics]'
const DIAGNOSTIC_TEXT_LIMIT = 600
const DIAGNOSTIC_ARG_LIMIT = 20
const DIAGNOSTIC_ARG_TEXT_LIMIT = 160

export function logCheckpointDiagnostic(buildMessage: () => string): void {
  if (!isDebugMode()) return
  logForDebugging(`${CHECKPOINT_DIAGNOSTIC_PREFIX} ${buildMessage()}`)
}

export function truncateDiagnostic(
  value: string | undefined,
  max = DIAGNOSTIC_TEXT_LIMIT,
): string {
  if (!value) return ''
  const singleLine = value.replace(/\r/g, '\\r').replace(/\n/g, '\\n')
  if (singleLine.length <= max) return singleLine
  return `${singleLine.slice(0, max)}...<truncated ${singleLine.length - max} chars>`
}

export function quoteDiagnostic(
  value: string | undefined,
  max = DIAGNOSTIC_TEXT_LIMIT,
): string {
  return JSON.stringify(truncateDiagnostic(value, max)) ?? '""'
}

export function formatArgsDiagnostic(args: readonly string[]): string {
  const shown = args
    .slice(0, DIAGNOSTIC_ARG_LIMIT)
    .map(arg => quoteDiagnostic(arg, DIAGNOSTIC_ARG_TEXT_LIMIT))
    .join(' ')
  const hidden = args.length - DIAGNOSTIC_ARG_LIMIT
  return hidden > 0 ? `${shown} ...(+${hidden} args)` : shown
}
