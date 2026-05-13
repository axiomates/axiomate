import { readFile } from 'fs/promises'
import { join } from 'path'
import { isInBundledMode } from './bundledMode.js'
import { getRipgrepStatus } from './ripgrep.js'
import { SandboxManager } from './sandbox/sandbox-adapter.js'
import { getManagedFilePath } from './settings/managedPath.js'
import { CUSTOMIZATION_SURFACES } from './settings/types.js'
import { jsonParse } from './slowOperations.js'

export type DiagnosticInfo = {
  version: string
  invokedBinary: string
  warnings: Array<{ issue: string; fix: string }>
  ripgrepStatus: {
    working: boolean
    mode: 'system' | 'embedded'
    systemPath: string | null
  }
}

export function getInvokedBinary(): string {
  try {
    if (isInBundledMode()) {
      return process.execPath || 'unknown'
    }
    return process.argv[1] || 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Managed-settings forwards-compat check. The schema preprocess silently
 * drops unknown strictPluginOnlyCustomization surface names so one future
 * enum value doesn't null out the entire policy file. But admins should
 * KNOW — read the raw file and diff.
 */
async function detectManagedSettingsWarnings(): Promise<
  Array<{ issue: string; fix: string }>
> {
  const warnings: Array<{ issue: string; fix: string }> = []
  try {
    const raw = await readFile(
      join(getManagedFilePath(), 'managed-settings.json'),
      'utf-8',
    )
    const parsed: unknown = jsonParse(raw)
    const field =
      parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>).strictPluginOnlyCustomization
        : undefined
    if (field !== undefined && typeof field !== 'boolean') {
      if (!Array.isArray(field)) {
        warnings.push({
          issue: `managed-settings.json: strictPluginOnlyCustomization has an invalid value (expected true or an array, got ${typeof field})`,
          fix: `The field is silently ignored (schema .catch rescues it). Set it to true, or an array of: ${CUSTOMIZATION_SURFACES.join(', ')}.`,
        })
      } else {
        const unknown = field.filter(
          x =>
            typeof x === 'string' &&
            !(CUSTOMIZATION_SURFACES as readonly string[]).includes(x),
        )
        if (unknown.length > 0) {
          warnings.push({
            issue: `managed-settings.json: strictPluginOnlyCustomization has ${unknown.length} value(s) this client doesn't recognize: ${unknown.map(String).join(', ')}`,
            fix: `These are silently ignored (forwards-compat). Known surfaces for this version: ${CUSTOMIZATION_SURFACES.join(', ')}. Either remove them, or this client is older than the managed-settings intended.`,
          })
        }
      }
    }
  } catch {
    // ENOENT / parse error — not this check's concern.
  }
  return warnings
}

export function detectLinuxGlobPatternWarnings(): Array<{
  issue: string
  fix: string
}> {
  if (process.platform !== 'linux') {
    return []
  }

  const warnings: Array<{ issue: string; fix: string }> = []
  const globPatterns = SandboxManager.getLinuxGlobPatternWarnings()

  if (globPatterns.length > 0) {
    const displayPatterns = globPatterns.slice(0, 3).join(', ')
    const remaining = globPatterns.length - 3
    const patternList =
      remaining > 0 ? `${displayPatterns} (${remaining} more)` : displayPatterns

    warnings.push({
      issue: `Glob patterns in sandbox permission rules are not fully supported on Linux`,
      fix: `Found ${globPatterns.length} pattern(s): ${patternList}. On Linux, glob patterns in Edit/Read rules will be ignored.`,
    })
  }

  return warnings
}

export async function getDoctorDiagnostic(): Promise<DiagnosticInfo> {
  const version =
    typeof MACRO !== 'undefined' && MACRO.VERSION ? MACRO.VERSION : 'unknown'
  const invokedBinary = getInvokedBinary()
  const warnings = [
    ...(await detectManagedSettingsWarnings()),
    ...detectLinuxGlobPatternWarnings(),
  ]

  const ripgrepStatusRaw = getRipgrepStatus()
  const ripgrepStatus = {
    working: ripgrepStatusRaw.working ?? true,
    mode: ripgrepStatusRaw.mode,
    systemPath:
      ripgrepStatusRaw.mode === 'system' ? ripgrepStatusRaw.path : null,
  }

  return {
    version,
    invokedBinary,
    warnings,
    ripgrepStatus,
  }
}
