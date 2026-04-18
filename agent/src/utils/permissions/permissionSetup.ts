import { feature } from 'bun:bundle'
import { relative } from 'path'
import {
  getOriginalCwd,
  handlePlanModeTransition,
  setHasExitedPlanMode,
} from '../../bootstrap/state.js'
import type {
  ToolPermissionContext,
} from '../../Tool.js'
import { getCwd } from '../cwd.js'
import type { SettingSource } from '../settings/constants.js'
import { SETTING_SOURCES } from '../settings/constants.js'
import {
  getSettings_DEPRECATED,
  getSettingsFilePathForSource,
} from '../settings/settings.js'
import {
  type PermissionMode,
  permissionModeFromString,
} from './PermissionMode.js'
import { applyPermissionRulesToPermissionContext } from './permissions.js'
import { loadAllPermissionRulesFromDisk } from './permissionsLoader.js'

import { resolve } from 'path'
import {
  addDirHelpMessage,
  validateDirectoryForWorkspace,
} from '../../commands/add-dir/validation.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { getToolsForDefaultPreset, parseToolPreset } from '../../tools.js'
import {
  getFsImplementation,
  safeResolvePath,
} from '../../utils/fsOperations.js'
import { logForDebugging } from '../debug.js'
import type {
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
} from './PermissionRule.js'
import {
  type AdditionalWorkingDirectory,
  applyPermissionUpdate,
} from './PermissionUpdate.js'
import {
  permissionRuleValueFromString,
} from './permissionRuleParser.js'

function formatPermissionSource(source: PermissionRuleSource): string {
  if ((SETTING_SOURCES as readonly string[]).includes(source)) {
    const filePath = getSettingsFilePathForSource(source as SettingSource)
    if (filePath) {
      const relativePath = relative(getCwd(), filePath)
      return relativePath.length < filePath.length ? relativePath : filePath
    }
  }
  return source
}

export type DangerousPermissionInfo = {
  ruleValue: PermissionRuleValue
  source: PermissionRuleSource
  /** The permission rule formatted for display, e.g. "Bash(*)" or "Bash(python:*)" */
  ruleDisplay: string
  /** The source formatted for display, e.g. a file path or "--allowed-tools" */
  sourceDisplay: string
}

/**
 * Checks if a Bash allow rule is overly broad (equivalent to YOLO mode).
 * Returns true for tool-level Bash allow rules with no content restriction,
 * which auto-allow every bash command.
 *
 * Matches: Bash, Bash(*), Bash() — all parse to { toolName: 'Bash' } with no ruleContent.
 */
export function isOverlyBroadBashAllowRule(
  ruleValue: PermissionRuleValue,
): boolean {
  return (
    ruleValue.toolName === BASH_TOOL_NAME && ruleValue.ruleContent === undefined
  )
}

/**
 * PowerShell equivalent of isOverlyBroadBashAllowRule.
 *
 * Matches: PowerShell, PowerShell(*), PowerShell() — all parse to
 * { toolName: 'PowerShell' } with no ruleContent.
 */
export function isOverlyBroadPowerShellAllowRule(
  ruleValue: PermissionRuleValue,
): boolean {
  return (
    ruleValue.toolName === POWERSHELL_TOOL_NAME &&
    ruleValue.ruleContent === undefined
  )
}

/**
 * Finds all overly broad Bash allow rules from settings and CLI arguments.
 * An overly broad rule allows ALL bash commands (e.g., Bash or Bash(*)),
 * which is effectively equivalent to YOLO/bypass-permissions mode.
 */
export function findOverlyBroadBashPermissions(
  rules: PermissionRule[],
  cliAllowedTools: string[],
): DangerousPermissionInfo[] {
  const overlyBroad: DangerousPermissionInfo[] = []

  for (const rule of rules) {
    if (
      rule.ruleBehavior === 'allow' &&
      isOverlyBroadBashAllowRule(rule.ruleValue)
    ) {
      overlyBroad.push({
        ruleValue: rule.ruleValue,
        source: rule.source,
        ruleDisplay: `${BASH_TOOL_NAME}(*)`,
        sourceDisplay: formatPermissionSource(rule.source),
      })
    }
  }

  for (const toolSpec of cliAllowedTools) {
    const parsed = permissionRuleValueFromString(toolSpec)
    if (isOverlyBroadBashAllowRule(parsed)) {
      overlyBroad.push({
        ruleValue: parsed,
        source: 'cliArg',
        ruleDisplay: `${BASH_TOOL_NAME}(*)`,
        sourceDisplay: '--allowed-tools',
      })
    }
  }

  return overlyBroad
}

/**
 * PowerShell equivalent of findOverlyBroadBashPermissions.
 */
export function findOverlyBroadPowerShellPermissions(
  rules: PermissionRule[],
  cliAllowedTools: string[],
): DangerousPermissionInfo[] {
  const overlyBroad: DangerousPermissionInfo[] = []

  for (const rule of rules) {
    if (
      rule.ruleBehavior === 'allow' &&
      isOverlyBroadPowerShellAllowRule(rule.ruleValue)
    ) {
      overlyBroad.push({
        ruleValue: rule.ruleValue,
        source: rule.source,
        ruleDisplay: `${POWERSHELL_TOOL_NAME}(*)`,
        sourceDisplay: formatPermissionSource(rule.source),
      })
    }
  }

  for (const toolSpec of cliAllowedTools) {
    const parsed = permissionRuleValueFromString(toolSpec)
    if (isOverlyBroadPowerShellAllowRule(parsed)) {
      overlyBroad.push({
        ruleValue: parsed,
        source: 'cliArg',
        ruleDisplay: `${POWERSHELL_TOOL_NAME}(*)`,
        sourceDisplay: '--allowed-tools',
      })
    }
  }

  return overlyBroad
}

/**
 * Handles all state transitions when switching permission modes.
 * Centralises side-effects so that every activation path (CLI Shift+Tab,
 * SDK control messages, etc.) behaves identically.
 *
 * Returns the (possibly modified) context. Caller is responsible for setting
 * the mode on the returned context.
 */
export function transitionPermissionMode(
  fromMode: string,
  toMode: string,
  context: ToolPermissionContext,
): ToolPermissionContext {
  // plan→plan (SDK set_permission_mode) would wrongly hit the leave branch below
  if (fromMode === toMode) return context

  handlePlanModeTransition(fromMode, toMode)

  if (fromMode === 'plan' && toMode !== 'plan') {
    setHasExitedPlanMode(true)
  }

  // Only spread if there's something to clear (preserves ref equality)
  if (fromMode === 'plan' && toMode !== 'plan' && context.prePlanMode) {
    return { ...context, prePlanMode: undefined }
  }

  return context
}

/**
 * Parse base tools specification from CLI
 * Handles both preset names (default, none) and custom tool lists
 */
export function parseBaseToolsFromCLI(baseTools: string[]): string[] {
  // Join all array elements and check if it's a single preset name
  const joinedInput = baseTools.join(' ').trim()
  const preset = parseToolPreset(joinedInput)

  if (preset) {
    return getToolsForDefaultPreset()
  }

  // Parse as a custom tool list using the same parsing logic as allowedTools/disallowedTools
  const parsedTools = parseToolListFromCLI(baseTools)

  return parsedTools
}

/**
 * Check if processPwd is a symlink that resolves to originalCwd
 */
function isSymlinkTo({
  processPwd,
  originalCwd,
}: {
  processPwd: string
  originalCwd: string
}): boolean {
  // Use safeResolvePath to check if processPwd is a symlink and get its resolved path
  const { resolvedPath: resolvedProcessPwd, isSymlink: isProcessPwdSymlink } =
    safeResolvePath(getFsImplementation(), processPwd)

  return isProcessPwdSymlink
    ? resolvedProcessPwd === resolve(originalCwd)
    : false
}

/**
 * Safely convert CLI flags to a PermissionMode
 */
export function initialPermissionModeFromCLI({
  permissionModeCli,
}: {
  permissionModeCli: string | undefined
}): { mode: PermissionMode; notification?: string } {
  const settings = getSettings_DEPRECATED() || {}

  // Modes in order of priority
  const orderedModes: PermissionMode[] = []
  const notification: string | undefined = undefined

  if (permissionModeCli) {
    const parsedMode = permissionModeFromString(permissionModeCli)
    orderedModes.push(parsedMode)
  }
  if (settings.permissions?.defaultMode) {
    const settingsMode = settings.permissions.defaultMode as PermissionMode
    orderedModes.push(settingsMode)
  }

  let result: { mode: PermissionMode; notification?: string } | undefined

  for (const mode of orderedModes) {
    result = { mode, notification } // Use the first valid mode
    break
  }

  if (!result) {
    result = { mode: 'default', notification }
  }

  return result
}

export function parseToolListFromCLI(tools: string[]): string[] {
  if (tools.length === 0) {
    return []
  }

  const result: string[] = []

  // Process each string in the array
  for (const toolString of tools) {
    if (!toolString) continue

    let current = ''
    let isInParens = false

    // Parse each character in the string
    for (const char of toolString) {
      switch (char) {
        case '(':
          isInParens = true
          current += char
          break
        case ')':
          isInParens = false
          current += char
          break
        case ',':
          if (isInParens) {
            current += char
          } else {
            // Comma separator - push current tool and start new one
            if (current.trim()) {
              result.push(current.trim())
            }
            current = ''
          }
          break
        case ' ':
          if (isInParens) {
            current += char
          } else if (current.trim()) {
            // Space separator - push current tool and start new one
            result.push(current.trim())
            current = ''
          }
          break
        default:
          current += char
      }
    }

    // Push any remaining tool
    if (current.trim()) {
      result.push(current.trim())
    }
  }

  return result
}

export async function initializeToolPermissionContext({
  allowedToolsCli,
  disallowedToolsCli,
  baseToolsCli,
  permissionMode,
  addDirs,
}: {
  allowedToolsCli: string[]
  disallowedToolsCli: string[]
  baseToolsCli?: string[]
  permissionMode: PermissionMode
  addDirs: string[]
}): Promise<{
  toolPermissionContext: ToolPermissionContext
  warnings: string[]
  overlyBroadBashPermissions: DangerousPermissionInfo[]
}> {
  // Parse comma-separated allowed and disallowed tools if provided
  const parsedAllowedToolsCli = parseToolListFromCLI(allowedToolsCli)
  let parsedDisallowedToolsCli = parseToolListFromCLI(disallowedToolsCli)

  // If base tools are specified, automatically deny all tools NOT in the base set
  if (baseToolsCli && baseToolsCli.length > 0) {
    const baseToolsResult = parseBaseToolsFromCLI(baseToolsCli)
    const baseToolsSet = new Set(baseToolsResult)
    const allToolNames = getToolsForDefaultPreset()
    const toolsToDisallow = allToolNames.filter(tool => !baseToolsSet.has(tool))
    parsedDisallowedToolsCli = [...parsedDisallowedToolsCli, ...toolsToDisallow]
  }

  const warnings: string[] = []
  const additionalWorkingDirectories = new Map<
    string,
    AdditionalWorkingDirectory
  >()
  // process.env.PWD may be a symlink, while getOriginalCwd() uses the real path
  const processPwd = process.env.PWD
  if (
    processPwd &&
    processPwd !== getOriginalCwd() &&
    isSymlinkTo({ originalCwd: getOriginalCwd(), processPwd })
  ) {
    additionalWorkingDirectories.set(processPwd, {
      path: processPwd,
      source: 'session',
    })
  }

  const settings = getSettings_DEPRECATED() || {}

  // Load all permission rules from disk
  const rulesFromDisk = loadAllPermissionRulesFromDisk()

  // Bash(*) or PowerShell(*) are equivalent to YOLO mode for that shell.
  // Variable name kept for return-field compat; contains both shells.
  let overlyBroadBashPermissions: DangerousPermissionInfo[] = []
  if (
    feature('DEV') &&
    process.env.AXIOMATE_CODE_ENTRYPOINT !== 'local-agent'
  ) {
    overlyBroadBashPermissions = [
      ...findOverlyBroadBashPermissions(rulesFromDisk, parsedAllowedToolsCli),
      ...findOverlyBroadPowerShellPermissions(
        rulesFromDisk,
        parsedAllowedToolsCli,
      ),
    ]
  }

  let toolPermissionContext = applyPermissionRulesToPermissionContext(
    {
      mode: permissionMode,
      additionalWorkingDirectories,
      alwaysAllowRules: { cliArg: parsedAllowedToolsCli },
      alwaysDenyRules: { cliArg: parsedDisallowedToolsCli },
      alwaysAskRules: {},
    },
    rulesFromDisk,
  )

  // Add directories from settings and --add-dir
  const allAdditionalDirectories = [
    ...(settings.permissions?.additionalDirectories || []),
    ...addDirs,
  ]
  const validationResults = await Promise.all(
    allAdditionalDirectories.map(dir =>
      validateDirectoryForWorkspace(dir, toolPermissionContext),
    ),
  )
  for (const result of validationResults) {
    if (result.resultType === 'success') {
      toolPermissionContext = applyPermissionUpdate(toolPermissionContext, {
        type: 'addDirectories',
        directories: [result.absolutePath],
        destination: 'cliArg',
      })
    } else if (
      result.resultType !== 'alreadyInWorkingDirectory' &&
      result.resultType !== 'pathNotFound'
    ) {
      // Warn for actual config mistakes (e.g. specifying a file instead of a
      // directory). But if the directory doesn't exist anymore (e.g. someone
      // was working under /tmp and it got cleared), silently skip.
      warnings.push(addDirHelpMessage(result))
    }
  }

  return {
    toolPermissionContext,
    warnings,
    overlyBroadBashPermissions,
  }
}

/**
 * Centralized plan-mode entry. Stashes the current mode as prePlanMode so
 * ExitPlanMode can restore it.
 */
export function prepareContextForPlanMode(
  context: ToolPermissionContext,
): ToolPermissionContext {
  const currentMode = context.mode
  if (currentMode === 'plan') return context
  logForDebugging(
    `[prepareContextForPlanMode] plain plan entry, prePlanMode=${currentMode}`,
    { level: 'info' },
  )
  return { ...context, prePlanMode: currentMode }
}
