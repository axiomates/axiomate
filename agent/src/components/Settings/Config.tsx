import { feature } from 'bun:bundle'
import {
  Box,
  Text,
  useTheme,
  useThemeSetting,
  useTerminalFocus,
} from '../../ink.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import * as React from 'react'
import { useState, useCallback } from 'react'
import {
  useKeybinding,
  useKeybindings,
} from '../../keybindings/useKeybinding.js'
import figures from 'figures'
import {
  type GlobalConfig,
  saveGlobalConfig,
  getCurrentProjectConfig,
  type OutputStyle,
} from '../../utils/config.js'
import { getGlobalConfig } from '../../utils/config.js'
import chalk from 'chalk'
import {
  permissionModeTitle,
  permissionModeFromString,
  toExternalPermissionMode,
  isExternalPermissionMode,
  EXTERNAL_PERMISSION_MODES,
  PERMISSION_MODES,
  type ExternalPermissionMode,
  type PermissionMode,
} from '../../utils/permissions/PermissionMode.js'
import { logError } from '../../utils/log.js'
import {
  logEvent,
} from '../../services/analytics/index.js'
import { ThemePicker } from '../ThemePicker.js'
import {
  useAppState,
  useSetAppState,
  useAppStateStore,
} from '../../state/AppState.js'
import { ModelPicker } from '../ModelPicker.js'
import { modelDisplayString } from '../../utils/model/model.js'
import { AxiomateMdExternalIncludesDialog } from '../MdExternalIncludesDialog.js'
import { Select } from '../CustomSelect/index.js'
import { OutputStylePicker } from '../OutputStylePicker.js'
import { LanguagePicker } from '../LanguagePicker.js'
import {
  getExternalAxiomateMdIncludes,
  getMemoryFiles,
  hasExternalAxiomateMdIncludes,
} from '../../utils/axiomatemd.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'
import { Byline } from '../design-system/Byline.js'
import { useTabHeaderFocus } from '../design-system/Tabs.js'
import { useIsInsideModal } from '../../context/modalContext.js'
import { SearchBox } from '../SearchBox.js'
import {
  isSupportedTerminal,
  hasAccessToIDEExtensionDiffFeature,
} from '../../utils/ide.js'
import {
  getInitialSettings,
  getSettingsForSource,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { DEFAULT_OUTPUT_STYLE_NAME } from '../../constants/outputStyles.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import type {
  LocalJSXCommandContext,
  CommandResultDisplay,
} from '../../commands.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import {
  getCliTeammateModeOverride,
  clearCliTeammateModeOverride,
} from '../../utils/swarm/backends/teammateModeSnapshot.js'
import { getHardcodedTeammateModelFallback } from '../../utils/swarm/teammateModel.js'
import { useSearchInput } from '../../hooks/useSearchInput.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'

type Props = {
  onClose: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  context: LocalJSXCommandContext
  setTabsHidden: (hidden: boolean) => void
  onIsSearchModeChange?: (inSearchMode: boolean) => void
  contentHeight?: number
}

type SettingBase =
  | {
      id: string
      label: string
    }
  | {
      id: string
      label: React.ReactNode
      searchText: string
    }

type Setting =
  | (SettingBase & {
      value: boolean
      onChange(value: boolean): void
      type: 'boolean'
    })
  | (SettingBase & {
      value: string
      options: string[]
      onChange(value: string): void
      type: 'enum'
    })
  | (SettingBase & {
      // For enums that are set by a custom component, we don't need to pass options,
      // but we still need a value to display in the top-level config menu
      value: string
      onChange(value: string): void
      type: 'managedEnum'
    })

type SubMenu =
  | 'Theme'
  | 'Model'
  | 'TeammateModel'
  | 'ExternalIncludes'
  | 'OutputStyle'
  | 'Language'
export function Config({
  onClose,
  context,
  setTabsHidden,
  onIsSearchModeChange,
  contentHeight,
}: Props): React.ReactNode {
  const { headerFocused, focusHeader } = useTabHeaderFocus()
  const insideModal = useIsInsideModal()
  const [, setTheme] = useTheme()
  const themeSetting = useThemeSetting()
  const [globalConfig, setGlobalConfig] = useState(getGlobalConfig())
  const initialConfig = React.useRef(getGlobalConfig())
  const [settingsData, setSettingsData] = useState(getInitialSettings())
  const initialSettingsData = React.useRef(getInitialSettings())
  const [currentOutputStyle, setCurrentOutputStyle] = useState<OutputStyle>(
    settingsData?.outputStyle || DEFAULT_OUTPUT_STYLE_NAME,
  )
  const initialOutputStyle = React.useRef(currentOutputStyle)
  const [currentLanguage, setCurrentLanguage] = useState<string | undefined>(
    settingsData?.language,
  )
  const initialLanguage = React.useRef(currentLanguage)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [scrollOffset, setScrollOffset] = useState(0)
  const [isSearchMode, setIsSearchMode] = useState(true)
  const isTerminalFocused = useTerminalFocus()
  const { rows } = useTerminalSize()
  // contentHeight is set by Settings.tsx (same value passed to Tabs to fix
  // pane height across all tabs — prevents layout jank when switching).
  // Reserve ~10 rows for chrome (search box, gaps, footer, scroll hints).
  // Fallback calc for standalone rendering (tests).
  const paneCap = contentHeight ?? Math.min(Math.floor(rows * 0.8), 30)
  const maxVisible = Math.max(5, paneCap - 10)
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const verbose = useAppState(s => s.verbose)
  const thinkingEnabled = useAppState(s => s.thinkingEnabled)
  const promptSuggestionEnabled = useAppState(s => s.promptSuggestionEnabled)
  const setAppState = useSetAppState()
  const [changes, setChanges] = useState<{ [key: string]: unknown }>({})
  const initialThinkingEnabled = React.useRef(thinkingEnabled)
  // Per-source settings snapshots for revert-on-escape. getInitialSettings()
  // returns merged-across-sources which can't tell us what to delete vs
  // restore; per-source snapshots + updateSettingsForSource's
  // undefined-deletes-key semantics can. Lazy-init via useState (no setter) to
  // avoid reading settings files on every render — useRef evaluates its arg
  // eagerly even though only the first result is kept.
  const [initialLocalSettings] = useState(() =>
    getSettingsForSource('localSettings'),
  )
  const [initialUserSettings] = useState(() =>
    getSettingsForSource('userSettings'),
  )
  const initialThemeSetting = React.useRef(themeSetting)
  // AppState fields Config may modify — snapshot once at mount.
  const store = useAppStateStore()
  const [initialAppState] = useState(() => {
    const s = store.getState()
    return {
      mainLoopModel: s.mainLoopModel,
      mainLoopModelForSession: s.mainLoopModelForSession,
      verbose: s.verbose,
      thinkingEnabled: s.thinkingEnabled,
      promptSuggestionEnabled: s.promptSuggestionEnabled,
      settings: s.settings,
    }
  })
  // Set on first user-visible change; gates revertChanges() on Escape so
  // opening-then-closing doesn't trigger redundant disk writes.
  const isDirty = React.useRef(false)
  const [showThinkingWarning, setShowThinkingWarning] = useState(false)
  const [showSubmenu, setShowSubmenu] = useState<SubMenu | null>(null)
  const {
    query: searchQuery,
    setQuery: setSearchQuery,
    cursorOffset: searchCursorOffset,
  } = useSearchInput({
    isActive: isSearchMode && showSubmenu === null && !headerFocused,
    onExit: () => setIsSearchMode(false),
    onExitUp: focusHeader,
    // Ctrl+C/D must reach Settings' useExitOnCtrlCD; 'd' also avoids
    // double-action (delete-char + exit-pending).
    passthroughCtrlKeys: ['c', 'd'],
  })

  // Tell the parent when Config's own Esc handler is active so Settings cedes
  // confirm:no. Only true when search mode owns the keyboard — not when the
  // tab header is focused (then Settings must handle Esc-to-close).
  const ownsEsc = isSearchMode && !headerFocused
  React.useEffect(() => {
    onIsSearchModeChange?.(ownsEsc)
  }, [ownsEsc, onIsSearchModeChange])

  const isConnectedToIde = hasAccessToIDEExtensionDiffFeature(
    context.options.mcpClients,
  )

  const isFileCheckpointingAvailable = !isEnvTruthy(
    process.env.AXIOMATE_CODE_DISABLE_FILE_CHECKPOINTING,
  )

  const memoryFiles = React.use(getMemoryFiles(true))
  const shouldShowExternalIncludesToggle =
    hasExternalAxiomateMdIncludes(memoryFiles)

  function onChangeMainModelConfig(value: string | null): void {
    const previousModel = mainLoopModel
    setAppState(prev => ({
      ...prev,
      mainLoopModel: value,
      mainLoopModelForSession: null,
    }))
    setChanges(prev => {
      const valStr = modelDisplayString(value)
      if ('model' in prev) {
        const { model, ...rest } = prev
        return { ...rest, model: valStr }
      }
      return { ...prev, model: valStr }
    })
  }

  function onChangeVerbose(value: boolean): void {
    // Update the global config to persist the setting
    saveGlobalConfig(current => ({ ...current, verbose: value }))
    setGlobalConfig({ ...getGlobalConfig(), verbose: value })

    // Update the app state for immediate UI feedback
    setAppState(prev => ({
      ...prev,
      verbose: value,
    }))
    setChanges(prev => {
      if ('verbose' in prev) {
        const { verbose, ...rest } = prev
        return rest
      }
      return { ...prev, verbose: value }
    })
  }

  // TODO: Add MCP servers
  const settingsItems: Setting[] = [
    // Global settings
    {
      id: 'autoCompactEnabled',
      label: 'Auto-compact',
      value: globalConfig.autoCompactEnabled,
      type: 'boolean' as const,
      onChange(autoCompactEnabled: boolean) {
        saveGlobalConfig(current => ({ ...current, autoCompactEnabled }))
        setGlobalConfig({ ...getGlobalConfig(), autoCompactEnabled })
      },
    },
    {
      id: 'spinnerTipsEnabled',
      label: 'Show tips',
      value: settingsData?.spinnerTipsEnabled ?? true,
      type: 'boolean' as const,
      onChange(spinnerTipsEnabled: boolean) {
        updateSettingsForSource('localSettings', {
          spinnerTipsEnabled,
        })
        // Update local state to reflect the change immediately
        setSettingsData(prev => ({
          ...prev,
          spinnerTipsEnabled,
        }))
      },
    },
    {
      id: 'prefersReducedMotion',
      label: 'Reduce motion',
      value: settingsData?.prefersReducedMotion ?? false,
      type: 'boolean' as const,
      onChange(prefersReducedMotion: boolean) {
        updateSettingsForSource('localSettings', {
          prefersReducedMotion,
        })
        setSettingsData(prev => ({
          ...prev,
          prefersReducedMotion,
        }))
        // Sync to AppState so components react immediately
        setAppState(prev => ({
          ...prev,
          settings: { ...prev.settings, prefersReducedMotion },
        }))
      },
    },
    {
      id: 'thinkingEnabled',
      label: 'Thinking mode',
      value: thinkingEnabled ?? true,
      type: 'boolean' as const,
      onChange(enabled: boolean) {
        setAppState(prev => ({ ...prev, thinkingEnabled: enabled }))
        updateSettingsForSource('userSettings', {
          alwaysThinkingEnabled: enabled ? undefined : false,
        })
      },
    },
    {
      id: 'promptSuggestionEnabled',
      label: 'Prompt suggestions',
      value: promptSuggestionEnabled,
      type: 'boolean' as const,
      onChange(enabled: boolean) {
        setAppState(prev => ({ ...prev, promptSuggestionEnabled: enabled }))
        updateSettingsForSource('userSettings', {
          promptSuggestionEnabled: enabled ? undefined : false,
        })
      },
    },
    ...(promptSuggestionEnabled
      ? [
          {
            id: 'speculationEnabled',
            label: 'Speculative execution',
            value: settingsData?.speculationEnabled ?? false,
            type: 'boolean' as const,
            onChange(enabled: boolean) {
              updateSettingsForSource('userSettings', {
                speculationEnabled: enabled || undefined,
              })
              setSettingsData(prev => ({ ...prev, speculationEnabled: enabled }))
            },
          },
        ]
      : []),
    {
      id: 'deepSearchEnabled',
      label: 'Deep search in /resume (fuzzy)',
      value: settingsData?.deepSearchEnabled ?? false,
      type: 'boolean' as const,
      onChange(enabled: boolean) {
        updateSettingsForSource('userSettings', {
          deepSearchEnabled: enabled || undefined,
        })
        setSettingsData(prev => ({ ...prev, deepSearchEnabled: enabled }))
      },
    },
    {
      id: 'agenticSearchEnabled',
      label: 'Agentic search in /resume (LLM)',
      value: settingsData?.agenticSearchEnabled ?? false,
      type: 'boolean' as const,
      onChange(enabled: boolean) {
        updateSettingsForSource('userSettings', {
          agenticSearchEnabled: enabled || undefined,
        })
        setSettingsData(prev => ({ ...prev, agenticSearchEnabled: enabled }))
      },
    },
    // Opt-in feature toggles. These all mirror an AXIOMATE_CODE_ENABLE_*
    // env var; the helper at the feature's call site reads env-first-then-
    // settings. TODO: when settingsItems migrates from hardcoded to
    // iterating SUPPORTED_SETTINGS, these become automatic.
    {
      id: 'globalSearchEnabled',
      label: 'Advanced search dialogs (Ctrl+Shift+F/P, modal history)',
      value: settingsData?.globalSearchEnabled ?? false,
      type: 'boolean' as const,
      onChange(enabled: boolean) {
        updateSettingsForSource('userSettings', {
          globalSearchEnabled: enabled || undefined,
        })
        setSettingsData(prev => ({ ...prev, globalSearchEnabled: enabled }))
      },
    },
    {
      id: 'messageActionsEnabled',
      label: 'Message actions menu (shift+up)',
      value: settingsData?.messageActionsEnabled ?? false,
      type: 'boolean' as const,
      onChange(enabled: boolean) {
        updateSettingsForSource('userSettings', {
          messageActionsEnabled: enabled || undefined,
        })
        setSettingsData(prev => ({ ...prev, messageActionsEnabled: enabled }))
      },
    },
    {
      id: 'awaySummaryEnabled',
      label: 'Away summary recap (on refocus after >5 min)',
      value: settingsData?.awaySummaryEnabled ?? false,
      type: 'boolean' as const,
      onChange(enabled: boolean) {
        updateSettingsForSource('userSettings', {
          awaySummaryEnabled: enabled || undefined,
        })
        setSettingsData(prev => ({ ...prev, awaySummaryEnabled: enabled }))
      },
    },
    {
      id: 'sessionMemoryEnabled',
      label: 'Session memory (periodic MEMORY.md updates)',
      value: settingsData?.sessionMemoryEnabled ?? false,
      type: 'boolean' as const,
      onChange(enabled: boolean) {
        updateSettingsForSource('userSettings', {
          sessionMemoryEnabled: enabled || undefined,
        })
        setSettingsData(prev => ({ ...prev, sessionMemoryEnabled: enabled }))
      },
    },
    {
      id: 'extractMemoriesEnabled',
      label: 'Auto-extract memories at end of each turn',
      value: settingsData?.extractMemoriesEnabled ?? false,
      type: 'boolean' as const,
      onChange(enabled: boolean) {
        updateSettingsForSource('userSettings', {
          extractMemoriesEnabled: enabled || undefined,
        })
        setSettingsData(prev => ({
          ...prev,
          extractMemoriesEnabled: enabled,
        }))
      },
    },
    {
      id: 'builtInAgentsEnabled',
      label: 'Built-in Explore / Plan / Verification agents',
      value: settingsData?.builtInAgentsEnabled ?? false,
      type: 'boolean' as const,
      onChange(enabled: boolean) {
        updateSettingsForSource('userSettings', {
          builtInAgentsEnabled: enabled || undefined,
        })
        setSettingsData(prev => ({ ...prev, builtInAgentsEnabled: enabled }))
      },
    },
    {
      id: 'bashAstEnabled',
      label: 'Bash AST parser (stricter permission checks)',
      value: settingsData?.bashAstEnabled ?? false,
      type: 'boolean' as const,
      onChange(enabled: boolean) {
        updateSettingsForSource('userSettings', {
          bashAstEnabled: enabled || undefined,
        })
        setSettingsData(prev => ({ ...prev, bashAstEnabled: enabled }))
      },
    },
    ...(isFileCheckpointingAvailable
      ? [
          {
            id: 'fileCheckpointingEnabled',
            label: 'Rewind code (checkpoints)',
            value: globalConfig.fileCheckpointingEnabled,
            type: 'boolean' as const,
            onChange(enabled: boolean) {
              saveGlobalConfig(current => ({
                ...current,
                fileCheckpointingEnabled: enabled,
              }))
              setGlobalConfig({
                ...getGlobalConfig(),
                fileCheckpointingEnabled: enabled,
              })
            },
          },
        ]
      : []),
    {
      id: 'verbose',
      label: 'Verbose output',
      value: verbose,
      type: 'boolean',
      onChange: onChangeVerbose,
    },
    {
      id: 'terminalProgressBarEnabled',
      label: 'Terminal progress bar',
      value: globalConfig.terminalProgressBarEnabled,
      type: 'boolean' as const,
      onChange(terminalProgressBarEnabled: boolean) {
        saveGlobalConfig(current => ({
          ...current,
          terminalProgressBarEnabled,
        }))
        setGlobalConfig({ ...getGlobalConfig(), terminalProgressBarEnabled })
      },
    },
    {
      id: 'showTurnDuration',
      label: 'Show turn duration',
      value: globalConfig.showTurnDuration,
      type: 'boolean' as const,
      onChange(showTurnDuration: boolean) {
        saveGlobalConfig(current => ({ ...current, showTurnDuration }))
        setGlobalConfig({ ...getGlobalConfig(), showTurnDuration })
      },
    },
    {
      id: 'defaultPermissionMode',
      label: 'Default permission mode',
      value: settingsData?.permissions?.defaultMode || 'default',
      options: (() => {
        const priorityOrder: PermissionMode[] = ['default', 'plan']
        const allModes: readonly PermissionMode[] = EXTERNAL_PERMISSION_MODES
        return [
          ...priorityOrder,
          ...allModes.filter(m => !priorityOrder.includes(m)),
        ]
      })(),
      type: 'enum' as const,
      onChange(mode: string) {
        const parsedMode = permissionModeFromString(mode)
        // Internal modes (e.g. auto) are stored directly
        const validatedMode = isExternalPermissionMode(parsedMode)
          ? toExternalPermissionMode(parsedMode)
          : parsedMode
        const result = updateSettingsForSource('userSettings', {
          permissions: {
            ...settingsData?.permissions,
            defaultMode: validatedMode as ExternalPermissionMode,
          },
        })

        if (result.error) {
          logError(result.error)
          return
        }

        // Update local state to reflect the change immediately.
        // validatedMode is typed as the wide PermissionMode union but at
        // runtime is always a PERMISSION_MODES member (the options dropdown
        // is built from that array above), so this narrowing is sound.
        setSettingsData(prev => ({
          ...prev,
          permissions: {
            ...prev?.permissions,
            defaultMode: validatedMode as (typeof PERMISSION_MODES)[number],
          },
        }))
        // Track changes
        setChanges(prev => ({ ...prev, defaultPermissionMode: mode }))
      },
    },
    {
      id: 'respectGitignore',
      label: 'Respect .gitignore in file picker',
      value: globalConfig.respectGitignore,
      type: 'boolean' as const,
      onChange(respectGitignore: boolean) {
        saveGlobalConfig(current => ({ ...current, respectGitignore }))
        setGlobalConfig({ ...getGlobalConfig(), respectGitignore })
      },
    },
    {
      id: 'copyFullResponse',
      label: 'Always copy full response (skip /copy picker)',
      value: globalConfig.copyFullResponse,
      type: 'boolean' as const,
      onChange(copyFullResponse: boolean) {
        saveGlobalConfig(current => ({ ...current, copyFullResponse }))
        setGlobalConfig({ ...getGlobalConfig(), copyFullResponse })
      },
    },
    {
      id: 'visionLocateEnabled',
      label: 'Enable vision_locate (high-cost visual loop)',
      value: globalConfig.visionLocateEnabled ?? false,
      type: 'boolean' as const,
      onChange(visionLocateEnabled: boolean) {
        saveGlobalConfig(current => ({ ...current, visionLocateEnabled }))
        setGlobalConfig({ ...getGlobalConfig(), visionLocateEnabled })
      },
    },
    // Copy-on-select is only meaningful with in-app selection (fullscreen
    // alt-screen mode). In inline mode the terminal emulator owns selection.
    ...(isFullscreenEnvEnabled()
      ? [
          {
            id: 'copyOnSelect',
            label: 'Copy on select',
            value: globalConfig.copyOnSelect ?? true,
            type: 'boolean' as const,
            onChange(copyOnSelect: boolean) {
              saveGlobalConfig(current => ({ ...current, copyOnSelect }))
              setGlobalConfig({ ...getGlobalConfig(), copyOnSelect })
            },
          },
        ]
      : []),
    {
      id: 'theme',
      label: 'Theme',
      value: themeSetting,
      type: 'managedEnum',
      onChange: setTheme,
    },
    {
      id: 'notifChannel',
      label: 'Notifications',
      value: globalConfig.preferredNotifChannel,
      options: [
        'auto',
        'iterm2',
        'terminal_bell',
        'iterm2_with_bell',
        'kitty',
        'ghostty',
        'notifications_disabled',
      ],
      type: 'enum',
      onChange(notifChannel: GlobalConfig['preferredNotifChannel']) {
        saveGlobalConfig(current => ({
          ...current,
          preferredNotifChannel: notifChannel,
        }))
        setGlobalConfig({
          ...getGlobalConfig(),
          preferredNotifChannel: notifChannel,
        })
      },
    },
    {
      id: 'outputStyle',
      label: 'Output style',
      value: currentOutputStyle,
      type: 'managedEnum' as const,
      onChange: () => {}, // handled by OutputStylePicker submenu
    },
    {
      id: 'language',
      label: 'Language',
      value: currentLanguage ?? 'Default (English)',
      type: 'managedEnum' as const,
      onChange: () => {}, // handled by LanguagePicker submenu
    },
    {
      id: 'editorMode',
      label: 'Editor mode',
      // Convert 'emacs' to 'normal' for backward compatibility
      value:
        globalConfig.editorMode === 'emacs'
          ? 'normal'
          : globalConfig.editorMode || 'normal',
      options: ['normal', 'vim'],
      type: 'enum',
      onChange(value: string) {
        saveGlobalConfig(current => ({
          ...current,
          editorMode: value as GlobalConfig['editorMode'],
        }))
        setGlobalConfig({
          ...getGlobalConfig(),
          editorMode: value as GlobalConfig['editorMode'],
        })

      },
    },
    {
      id: 'prStatusFooterEnabled',
      label: 'Show PR status footer',
      value: globalConfig.prStatusFooterEnabled ?? true,
      type: 'boolean' as const,
      onChange(enabled: boolean) {
        saveGlobalConfig(current => {
          if (current.prStatusFooterEnabled === enabled) return current
          return {
            ...current,
            prStatusFooterEnabled: enabled,
          }
        })
        setGlobalConfig({
          ...getGlobalConfig(),
          prStatusFooterEnabled: enabled,
        })
      },
    },
    {
      id: 'model',
      label: 'Model',
      value: mainLoopModel === null ? 'Default (recommended)' : mainLoopModel,
      type: 'managedEnum' as const,
      onChange: onChangeMainModelConfig,
    },
    ...(isConnectedToIde
      ? [
          {
            id: 'diffTool',
            label: 'Diff tool',
            value: globalConfig.diffTool ?? 'auto',
            options: ['terminal', 'auto'],
            type: 'enum' as const,
            onChange(diffTool: string) {
              saveGlobalConfig(current => ({
                ...current,
                diffTool: diffTool as GlobalConfig['diffTool'],
              }))
              setGlobalConfig({
                ...getGlobalConfig(),
                diffTool: diffTool as GlobalConfig['diffTool'],
              })

            },
          },
        ]
      : []),
    ...(!isSupportedTerminal()
      ? [
          {
            id: 'autoConnectIde',
            label: 'Auto-connect to IDE (external terminal)',
            value: globalConfig.autoConnectIde ?? false,
            type: 'boolean' as const,
            onChange(autoConnectIde: boolean) {
              saveGlobalConfig(current => ({ ...current, autoConnectIde }))
              setGlobalConfig({ ...getGlobalConfig(), autoConnectIde })

            },
          },
        ]
      : []),
    ...(isSupportedTerminal()
      ? [
          {
            id: 'autoInstallIdeExtension',
            label: 'Auto-install IDE extension',
            value: globalConfig.autoInstallIdeExtension ?? true,
            type: 'boolean' as const,
            onChange(autoInstallIdeExtension: boolean) {
              saveGlobalConfig(current => ({
                ...current,
                autoInstallIdeExtension,
              }))
              setGlobalConfig({ ...getGlobalConfig(), autoInstallIdeExtension })

            },
          },
        ]
      : []),
    // Teammate mode (only shown when agent swarms are enabled)
    ...(isAgentSwarmsEnabled()
      ? (() => {
          const cliOverride = getCliTeammateModeOverride()
          const label = cliOverride
            ? `Teammate mode [overridden: ${cliOverride}]`
            : 'Teammate mode'
          return [
            {
              id: 'teammateMode',
              label,
              value: globalConfig.teammateMode ?? 'auto',
              options: ['auto', 'tmux', 'in-process'],
              type: 'enum' as const,
              onChange(mode: string) {
                if (
                  mode !== 'auto' &&
                  mode !== 'tmux' &&
                  mode !== 'in-process'
                ) {
                  return
                }
                // Clear CLI override and set new mode (pass mode to avoid race condition)
                clearCliTeammateModeOverride(mode)
                saveGlobalConfig(current => ({
                  ...current,
                  teammateMode: mode,
                }))
                setGlobalConfig({
                  ...getGlobalConfig(),
                  teammateMode: mode,
                })
              },
            },
            {
              id: 'teammateDefaultModel',
              label: 'Default teammate model',
              value: teammateModelDisplayString(
                globalConfig.teammateDefaultModel,
              ),
              type: 'managedEnum' as const,
              onChange() {},
            },
          ]
        })()
      : []),
    ...(shouldShowExternalIncludesToggle
      ? [
          {
            id: 'showExternalIncludesDialog',
            label: 'External AXIOMATE.md includes',
            value: (() => {
              const projectConfig = getCurrentProjectConfig()
              if (projectConfig.hasAxiomateMdExternalIncludesApproved) {
                return 'true'
              } else {
                return 'false'
              }
            })(),
            type: 'managedEnum' as const,
            onChange() {
              // Will be handled by toggleSetting function
            },
          },
        ]
      : []),
  ]

  // Filter settings based on search query
  const filteredSettingsItems = React.useMemo(() => {
    if (!searchQuery) return settingsItems
    const lowerQuery = searchQuery.toLowerCase()
    return settingsItems.filter(setting => {
      if (setting.id.toLowerCase().includes(lowerQuery)) return true
      const searchableText =
        'searchText' in setting ? setting.searchText : setting.label
      return searchableText.toLowerCase().includes(lowerQuery)
    })
  }, [settingsItems, searchQuery])

  // Adjust selected index when filtered list shrinks, and keep the selected
  // item visible when maxVisible changes (e.g., terminal resize).
  React.useEffect(() => {
    if (selectedIndex >= filteredSettingsItems.length) {
      const newIndex = Math.max(0, filteredSettingsItems.length - 1)
      setSelectedIndex(newIndex)
      setScrollOffset(Math.max(0, newIndex - maxVisible + 1))
      return
    }
    setScrollOffset(prev => {
      if (selectedIndex < prev) return selectedIndex
      if (selectedIndex >= prev + maxVisible)
        return selectedIndex - maxVisible + 1
      return prev
    })
  }, [filteredSettingsItems.length, selectedIndex, maxVisible])

  // Keep the selected item visible within the scroll window.
  // Called synchronously from navigation handlers to avoid a render frame
  // where the selected item falls outside the visible window.
  const adjustScrollOffset = useCallback(
    (newIndex: number) => {
      setScrollOffset(prev => {
        if (newIndex < prev) return newIndex
        if (newIndex >= prev + maxVisible) return newIndex - maxVisible + 1
        return prev
      })
    },
    [maxVisible],
  )

  // Enter: keep all changes (already persisted by onChange handlers), close
  // with a summary of what changed.
  const handleSaveAndClose = useCallback(() => {
    // Submenu handling: each submenu has its own Enter/Esc — don't close
    // the whole panel while one is open.
    if (showSubmenu !== null) {
      return
    }
    // Log any changes that were made
    // TODO: Make these proper messages
    const formattedChanges: string[] = Object.entries(changes).map(
      ([key, value]) => {
        return `Set ${key} to ${chalk.bold(value)}`
      },
    )
    if (globalConfig.theme !== initialConfig.current.theme) {
      formattedChanges.push(`Set theme to ${chalk.bold(globalConfig.theme)}`)
    }
    if (
      globalConfig.preferredNotifChannel !==
      initialConfig.current.preferredNotifChannel
    ) {
      formattedChanges.push(
        `Set notifications to ${chalk.bold(globalConfig.preferredNotifChannel)}`,
      )
    }
    if (currentOutputStyle !== initialOutputStyle.current) {
      formattedChanges.push(
        `Set output style to ${chalk.bold(currentOutputStyle)}`,
      )
    }
    if (currentLanguage !== initialLanguage.current) {
      formattedChanges.push(
        `Set response language to ${chalk.bold(currentLanguage ?? 'Default (English)')}`,
      )
    }
    if (globalConfig.editorMode !== initialConfig.current.editorMode) {
      formattedChanges.push(
        `Set editor mode to ${chalk.bold(globalConfig.editorMode || 'emacs')}`,
      )
    }
    if (globalConfig.diffTool !== initialConfig.current.diffTool) {
      formattedChanges.push(
        `Set diff tool to ${chalk.bold(globalConfig.diffTool)}`,
      )
    }
    if (globalConfig.autoConnectIde !== initialConfig.current.autoConnectIde) {
      formattedChanges.push(
        `${globalConfig.autoConnectIde ? 'Enabled' : 'Disabled'} auto-connect to IDE`,
      )
    }
    if (
      globalConfig.autoInstallIdeExtension !==
      initialConfig.current.autoInstallIdeExtension
    ) {
      formattedChanges.push(
        `${globalConfig.autoInstallIdeExtension ? 'Enabled' : 'Disabled'} auto-install IDE extension`,
      )
    }
    if (
      globalConfig.autoCompactEnabled !==
      initialConfig.current.autoCompactEnabled
    ) {
      formattedChanges.push(
        `${globalConfig.autoCompactEnabled ? 'Enabled' : 'Disabled'} auto-compact`,
      )
    }
    if (
      globalConfig.respectGitignore !== initialConfig.current.respectGitignore
    ) {
      formattedChanges.push(
        `${globalConfig.respectGitignore ? 'Enabled' : 'Disabled'} respect .gitignore in file picker`,
      )
    }
    if (
      globalConfig.copyFullResponse !== initialConfig.current.copyFullResponse
    ) {
      formattedChanges.push(
        `${globalConfig.copyFullResponse ? 'Enabled' : 'Disabled'} always copy full response`,
      )
    }
    if (globalConfig.copyOnSelect !== initialConfig.current.copyOnSelect) {
      formattedChanges.push(
        `${globalConfig.copyOnSelect ? 'Enabled' : 'Disabled'} copy on select`,
      )
    }
    if (
      globalConfig.terminalProgressBarEnabled !==
      initialConfig.current.terminalProgressBarEnabled
    ) {
      formattedChanges.push(
        `${globalConfig.terminalProgressBarEnabled ? 'Enabled' : 'Disabled'} terminal progress bar`,
      )
    }
    if (
      globalConfig.showStatusInTerminalTab !==
      initialConfig.current.showStatusInTerminalTab
    ) {
      formattedChanges.push(
        `${globalConfig.showStatusInTerminalTab ? 'Enabled' : 'Disabled'} terminal tab status`,
      )
    }
    if (
      globalConfig.showTurnDuration !== initialConfig.current.showTurnDuration
    ) {
      formattedChanges.push(
        `${globalConfig.showTurnDuration ? 'Enabled' : 'Disabled'} turn duration`,
      )
    }
    if (formattedChanges.length > 0) {
      onClose(formattedChanges.join('\n'))
    } else {
      onClose('Config dialog dismissed', { display: 'system' })
    }
  }, [
    showSubmenu,
    changes,
    globalConfig,
    mainLoopModel,
    currentOutputStyle,
    currentLanguage,
    onClose,
  ])

  // Restore all state stores to their mount-time snapshots. Changes are
  // applied to disk/AppState immediately on toggle, so "cancel" means
  // actively writing the old values back.
  const revertChanges = useCallback(() => {
    // Theme: restores ThemeProvider React state. Must run before the global
    // config overwrite since setTheme internally calls saveGlobalConfig with
    // a partial update — we want the full snapshot to be the last write.
    if (themeSetting !== initialThemeSetting.current) {
      setTheme(initialThemeSetting.current)
    }
    // Global config: full overwrite from snapshot. saveGlobalConfig skips if
    // the returned ref equals current (test mode checks ref; prod writes to
    // disk but content is identical).
    saveGlobalConfig(() => initialConfig.current)
    // Settings files: restore each key Config may have touched. undefined
    // deletes the key (updateSettingsForSource customizer at settings.ts:368).
    const il = initialLocalSettings
    updateSettingsForSource('localSettings', {
      spinnerTipsEnabled: il?.spinnerTipsEnabled,
      prefersReducedMotion: il?.prefersReducedMotion,
      outputStyle: il?.outputStyle,
    })
    const iu = initialUserSettings
    updateSettingsForSource('userSettings', {
      alwaysThinkingEnabled: iu?.alwaysThinkingEnabled,
      promptSuggestionEnabled: iu?.promptSuggestionEnabled,
      speculationEnabled: iu?.speculationEnabled,
      deepSearchEnabled: iu?.deepSearchEnabled,
      agenticSearchEnabled: iu?.agenticSearchEnabled,
      language: iu?.language,
      // ThemePicker's Ctrl+T writes this key directly — include it so the
      // disk state reverts along with the in-memory AppState.settings restore.
      syntaxHighlightingDisabled: iu?.syntaxHighlightingDisabled,
      // permissions: the defaultMode onChange (above) spreads the MERGED
      // settingsData.permissions into userSettings — project/policy allow/deny
      // arrays can leak to disk. Spread the full initial snapshot so the
      // mergeWith array-customizer (settings.ts:375) replaces leaked arrays.
      // Explicitly include defaultMode so undefined triggers the customizer's
      // delete path even when iu.permissions lacks that key.
      permissions:
        iu?.permissions === undefined
          ? undefined
          : { ...iu.permissions, defaultMode: iu.permissions.defaultMode },
    })
    // AppState: batch-restore all possibly-touched fields.
    const ia = initialAppState
    setAppState(prev => ({
      ...prev,
      mainLoopModel: ia.mainLoopModel,
      mainLoopModelForSession: ia.mainLoopModelForSession,
      verbose: ia.verbose,
      thinkingEnabled: ia.thinkingEnabled,
      promptSuggestionEnabled: ia.promptSuggestionEnabled,
      settings: ia.settings,
    }))
  }, [
    themeSetting,
    setTheme,
    initialLocalSettings,
    initialUserSettings,
    initialAppState,
    setAppState,
  ])

  // Escape: revert all changes (if any) and close.
  const handleEscape = useCallback(() => {
    if (showSubmenu !== null) {
      return
    }
    if (isDirty.current) {
      revertChanges()
    }
    onClose('Config dialog dismissed', { display: 'system' })
  }, [showSubmenu, revertChanges, onClose])

  // Disable when submenu is open so the submenu's Dialog handles ESC, and in
  // search mode so the onKeyDown handler (which clears-then-exits search)
  // wins — otherwise Escape in search would jump straight to revert+close.
  useKeybinding('confirm:no', handleEscape, {
    context: 'Settings',
    isActive: showSubmenu === null && !isSearchMode && !headerFocused,
  })
  // Save-and-close fires on Enter only when not in search mode (Enter there
  // exits search to the list — see the isSearchMode branch in handleKeyDown).
  useKeybinding('settings:close', handleSaveAndClose, {
    context: 'Settings',
    isActive: showSubmenu === null && !isSearchMode && !headerFocused,
  })

  // Settings navigation and toggle actions via configurable keybindings.
  // Only active when not in search mode and no submenu is open.
  const toggleSetting = useCallback(() => {
    const setting = filteredSettingsItems[selectedIndex]
    if (!setting || !setting.onChange) {
      return
    }

    if (setting.type === 'boolean') {
      isDirty.current = true
      setting.onChange(!setting.value)
      if (setting.id === 'thinkingEnabled') {
        const newValue = !setting.value
        const backToInitial = newValue === initialThinkingEnabled.current
        if (backToInitial) {
          setShowThinkingWarning(false)
        } else if (context.messages.some(m => m.type === 'assistant')) {
          setShowThinkingWarning(true)
        }
      }
      return
    }

    if (
      setting.id === 'theme' ||
      setting.id === 'model' ||
      setting.id === 'teammateDefaultModel' ||
      setting.id === 'showExternalIncludesDialog' ||
      setting.id === 'outputStyle' ||
      setting.id === 'language'
    ) {
      // managedEnum items open a submenu — isDirty is set by the submenu's
      // completion callback, not here (submenu may be cancelled).
      switch (setting.id) {
        case 'theme':
          setShowSubmenu('Theme')
          setTabsHidden(true)
          return
        case 'model':
          setShowSubmenu('Model')
          setTabsHidden(true)
          return
        case 'teammateDefaultModel':
          setShowSubmenu('TeammateModel')
          setTabsHidden(true)
          return
        case 'showExternalIncludesDialog':
          setShowSubmenu('ExternalIncludes')
          setTabsHidden(true)
          return
        case 'outputStyle':
          setShowSubmenu('OutputStyle')
          setTabsHidden(true)
          return
        case 'language':
          setShowSubmenu('Language')
          setTabsHidden(true)
          return
      }
    }

    if (setting.type === 'enum') {
      isDirty.current = true
      const currentIndex = setting.options.indexOf(setting.value)
      const nextIndex = (currentIndex + 1) % setting.options.length
      setting.onChange(setting.options[nextIndex]!)
      return
    }
  }, [
    filteredSettingsItems,
    selectedIndex,
    setTabsHidden,
  ])

  const moveSelection = (delta: -1 | 1): void => {
    setShowThinkingWarning(false)
    const newIndex = Math.max(
      0,
      Math.min(filteredSettingsItems.length - 1, selectedIndex + delta),
    )
    setSelectedIndex(newIndex)
    adjustScrollOffset(newIndex)
  }

  useKeybindings(
    {
      'select:previous': () => {
        if (selectedIndex === 0) {
          // ↑ at top enters search mode so users can type-to-filter after
          // reaching the list boundary. Wheel-up (scroll:lineUp) clamps
          // instead — overshoot shouldn't move focus away from the list.
          setShowThinkingWarning(false)
          setIsSearchMode(true)
          setScrollOffset(0)
        } else {
          moveSelection(-1)
        }
      },
      'select:next': () => moveSelection(1),
      // Wheel. ScrollKeybindingHandler's scroll:line* returns false (not
      // consumed) when the ScrollBox content fits — which it always does
      // here because the list is paginated (slice). The event falls through
      // to this handler which navigates the list, clamping at boundaries.
      'scroll:lineUp': () => moveSelection(-1),
      'scroll:lineDown': () => moveSelection(1),
      'select:accept': toggleSetting,
      'settings:search': () => {
        setIsSearchMode(true)
        setSearchQuery('')
      },
    },
    {
      context: 'Settings',
      isActive: showSubmenu === null && !isSearchMode && !headerFocused,
    },
  )

  // Combined key handling across search/list modes. Branch order mirrors
  // the original useInput gate priority: submenu and header short-circuit
  // first (their own handlers own input), then search vs. list.
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (showSubmenu !== null) return
      if (headerFocused) return
      // Search mode: Esc clears then exits, Enter/↓ moves to the list.
      if (isSearchMode) {
        if (e.key === 'escape') {
          e.preventDefault()
          if (searchQuery.length > 0) {
            setSearchQuery('')
          } else {
            setIsSearchMode(false)
          }
          return
        }
        if (e.key === 'return' || e.key === 'down' || e.key === 'wheeldown') {
          e.preventDefault()
          setIsSearchMode(false)
          setSelectedIndex(0)
          setScrollOffset(0)
        }
        return
      }
      // List mode: left/right/tab cycle the selected option's value. These
      // keys used to switch tabs; now they only do so when the tab row is
      // explicitly focused (see headerFocused in Settings.tsx).
      if (e.key === 'left' || e.key === 'right' || e.key === 'tab') {
        e.preventDefault()
        toggleSetting()
        return
      }
      // Fallback: printable characters (other than those bound to actions)
      // enter search mode. Carve out j/k// — useKeybindings (still on the
      // useInput path) consumes these via stopImmediatePropagation, but
      // onKeyDown dispatches independently so we must skip them explicitly.
      if (e.ctrl || e.meta) return
      if (e.key === 'j' || e.key === 'k' || e.key === '/') return
      if (e.key.length === 1 && e.key !== ' ') {
        e.preventDefault()
        setIsSearchMode(true)
        setSearchQuery(e.key)
      }
    },
    [
      showSubmenu,
      headerFocused,
      isSearchMode,
      searchQuery,
      setSearchQuery,
      toggleSetting,
    ],
  )

  return (
    <Box
      flexDirection="column"
      width="100%"
      tabIndex={0}
      autoFocus
      onKeyDown={handleKeyDown}
    >
      {showSubmenu === 'Theme' ? (
        <>
          <ThemePicker
            onThemeSelect={setting => {
              isDirty.current = true
              setTheme(setting)
              setShowSubmenu(null)
              setTabsHidden(false)
            }}
            onCancel={() => {
              setShowSubmenu(null)
              setTabsHidden(false)
            }}
            hideEscToCancel
            skipExitHandling={true} // Skip exit handling as Config already handles it
          />
          <Box>
            <Text dimColor italic>
              <Byline>
                <KeyboardShortcutHint shortcut="Enter" action="select" />
                <ConfigurableShortcutHint
                  action="confirm:no"
                  context="Confirmation"
                  fallback="Esc"
                  description="cancel"
                />
              </Byline>
            </Text>
          </Box>
        </>
      ) : showSubmenu === 'Model' ? (
        <>
          <ModelPicker
            initial={mainLoopModel}
            onSelect={(model, _effort) => {
              isDirty.current = true
              onChangeMainModelConfig(model)
              setShowSubmenu(null)
              setTabsHidden(false)
            }}
            onCancel={() => {
              setShowSubmenu(null)
              setTabsHidden(false)
            }}
          />
          <Text dimColor>
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action="confirm" />
              <ConfigurableShortcutHint
                action="confirm:no"
                context="Confirmation"
                fallback="Esc"
                description="cancel"
              />
            </Byline>
          </Text>
        </>
      ) : showSubmenu === 'TeammateModel' ? (
        <>
          <ModelPicker
            initial={globalConfig.teammateDefaultModel ?? null}
            skipSettingsWrite
            headerText="Default model for newly spawned teammates. The leader can override via the tool call's model parameter."
            onSelect={(model, _effort) => {
              setShowSubmenu(null)
              setTabsHidden(false)
              // First-open-then-Enter from unset: picker highlights "Default"
              // (initial=null) and confirming would write null, silently
              // switching default-model fallback → follow-leader. Treat as no-op.
              if (
                globalConfig.teammateDefaultModel === undefined &&
                model === null
              ) {
                return
              }
              isDirty.current = true
              saveGlobalConfig(current =>
                current.teammateDefaultModel === model
                  ? current
                  : { ...current, teammateDefaultModel: model },
              )
              setGlobalConfig({
                ...getGlobalConfig(),
                teammateDefaultModel: model,
              })
              setChanges(prev => ({
                ...prev,
                teammateDefaultModel: teammateModelDisplayString(model),
              }))
            }}
            onCancel={() => {
              setShowSubmenu(null)
              setTabsHidden(false)
            }}
          />
          <Text dimColor>
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action="confirm" />
              <ConfigurableShortcutHint
                action="confirm:no"
                context="Confirmation"
                fallback="Esc"
                description="cancel"
              />
            </Byline>
          </Text>
        </>
      ) : showSubmenu === 'ExternalIncludes' ? (
        <>
          <AxiomateMdExternalIncludesDialog
            onDone={() => {
              setShowSubmenu(null)
              setTabsHidden(false)
            }}
            externalIncludes={getExternalAxiomateMdIncludes(memoryFiles)}
          />
          <Text dimColor>
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action="confirm" />
              <ConfigurableShortcutHint
                action="confirm:no"
                context="Confirmation"
                fallback="Esc"
                description="disable external includes"
              />
            </Byline>
          </Text>
        </>
      ) : showSubmenu === 'OutputStyle' ? (
        <>
          <OutputStylePicker
            initialStyle={currentOutputStyle}
            onComplete={style => {
              isDirty.current = true
              setCurrentOutputStyle(style ?? DEFAULT_OUTPUT_STYLE_NAME)
              setShowSubmenu(null)
              setTabsHidden(false)

              // Save to local settings
              updateSettingsForSource('localSettings', {
                outputStyle: style,
              })

            }}
            onCancel={() => {
              setShowSubmenu(null)
              setTabsHidden(false)
            }}
          />
          <Text dimColor>
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action="confirm" />
              <ConfigurableShortcutHint
                action="confirm:no"
                context="Confirmation"
                fallback="Esc"
                description="cancel"
              />
            </Byline>
          </Text>
        </>
      ) : showSubmenu === 'Language' ? (
        <>
          <LanguagePicker
            initialLanguage={currentLanguage}
            onComplete={language => {
              isDirty.current = true
              setCurrentLanguage(language)
              setShowSubmenu(null)
              setTabsHidden(false)

              // Save to user settings
              updateSettingsForSource('userSettings', {
                language,
              })

            }}
            onCancel={() => {
              setShowSubmenu(null)
              setTabsHidden(false)
            }}
          />
          <Text dimColor>
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action="confirm" />
              <ConfigurableShortcutHint
                action="confirm:no"
                context="Settings"
                fallback="Esc"
                description="cancel"
              />
            </Byline>
          </Text>
        </>
      ) : (
        <Box
          flexDirection="column"
          gap={1}
          marginY={insideModal ? undefined : 1}
        >
          <SearchBox
            query={searchQuery}
            isFocused={isSearchMode && !headerFocused}
            isTerminalFocused={isTerminalFocused}
            cursorOffset={searchCursorOffset}
            placeholder="Search settings…"
          />
          <Box flexDirection="column">
            {filteredSettingsItems.length === 0 ? (
              <Text dimColor italic>
                No settings match &quot;{searchQuery}&quot;
              </Text>
            ) : (
              <>
                {scrollOffset > 0 && (
                  <Text dimColor>
                    {figures.arrowUp} {scrollOffset} more above
                  </Text>
                )}
                {filteredSettingsItems
                  .slice(scrollOffset, scrollOffset + maxVisible)
                  .map((setting, i) => {
                    const actualIndex = scrollOffset + i
                    const isSelected =
                      actualIndex === selectedIndex &&
                      !headerFocused &&
                      !isSearchMode

                    return (
                      <React.Fragment key={setting.id}>
                        <Box>
                          <Box width={44}>
                            <Text color={isSelected ? 'suggestion' : undefined}>
                              {isSelected ? figures.pointer : ' '}{' '}
                              {setting.label}
                            </Text>
                          </Box>
                          <Box key={isSelected ? 'selected' : 'unselected'}>
                            {setting.type === 'boolean' ? (
                              <>
                                <Text
                                  color={isSelected ? 'suggestion' : undefined}
                                >
                                  {setting.value.toString()}
                                </Text>
                                {showThinkingWarning &&
                                  setting.id === 'thinkingEnabled' && (
                                    <Text color="warning">
                                      {' '}
                                      Changing thinking mode mid-conversation
                                      will increase latency and may reduce
                                      quality.
                                    </Text>
                                  )}
                              </>
                            ) : setting.id === 'theme' ? (
                              <Text
                                color={isSelected ? 'suggestion' : undefined}
                              >
                                {THEME_LABELS[setting.value.toString()] ??
                                  setting.value.toString()}
                              </Text>
                            ) : setting.id === 'notifChannel' ? (
                              <Text
                                color={isSelected ? 'suggestion' : undefined}
                              >
                                <NotifChannelLabel
                                  value={setting.value.toString()}
                                />
                              </Text>
                            ) : setting.id === 'defaultPermissionMode' ? (
                              <Text
                                color={isSelected ? 'suggestion' : undefined}
                              >
                                {permissionModeTitle(
                                  setting.value as PermissionMode,
                                )}
                              </Text>
                            ) : (
                              <Text
                                color={isSelected ? 'suggestion' : undefined}
                              >
                                {setting.value.toString()}
                              </Text>
                            )}
                          </Box>
                        </Box>
                      </React.Fragment>
                    )
                  })}
                {scrollOffset + maxVisible < filteredSettingsItems.length && (
                  <Text dimColor>
                    {figures.arrowDown}{' '}
                    {filteredSettingsItems.length - scrollOffset - maxVisible}{' '}
                    more below
                  </Text>
                )}
              </>
            )}
          </Box>
          {headerFocused ? (
            <Text dimColor>
              <Byline>
                <KeyboardShortcutHint shortcut="←/→ tab" action="switch" />
                <KeyboardShortcutHint shortcut="↓" action="return" />
                <ConfigurableShortcutHint
                  action="confirm:no"
                  context="Settings"
                  fallback="Esc"
                  description="close"
                />
              </Byline>
            </Text>
          ) : isSearchMode ? (
            <Text dimColor>
              <Byline>
                <Text>Type to filter</Text>
                <KeyboardShortcutHint shortcut="Enter/↓" action="select" />
                <KeyboardShortcutHint shortcut="↑" action="tabs" />
                <ConfigurableShortcutHint
                  action="confirm:no"
                  context="Settings"
                  fallback="Esc"
                  description="clear"
                />
              </Byline>
            </Text>
          ) : (
            <Text dimColor>
              <Byline>
                <ConfigurableShortcutHint
                  action="select:accept"
                  context="Settings"
                  fallback="Space"
                  description="change"
                />
                <ConfigurableShortcutHint
                  action="settings:close"
                  context="Settings"
                  fallback="Enter"
                  description="save"
                />
                <ConfigurableShortcutHint
                  action="settings:search"
                  context="Settings"
                  fallback="/"
                  description="search"
                />
                <ConfigurableShortcutHint
                  action="confirm:no"
                  context="Settings"
                  fallback="Esc"
                  description="cancel"
                />
              </Byline>
            </Text>
          )}
        </Box>
      )}
    </Box>
  )
}

function teammateModelDisplayString(value: string | null | undefined): string {
  if (value === undefined) {
    return modelDisplayString(getHardcodedTeammateModelFallback())
  }
  if (value === null) return "Default (leader's model)"
  return modelDisplayString(value)
}

const THEME_LABELS: Record<string, string> = {
  auto: 'Auto (match terminal)',
  dark: 'Dark mode',
  light: 'Light mode',
  'dark-daltonized': 'Dark mode (colorblind-friendly)',
  'light-daltonized': 'Light mode (colorblind-friendly)',
  'dark-ansi': 'Dark mode (ANSI colors only)',
  'light-ansi': 'Light mode (ANSI colors only)',
}

function NotifChannelLabel({ value }: { value: string }): React.ReactNode {
  switch (value) {
    case 'auto':
      return 'Auto'
    case 'iterm2':
      return (
        <Text>
          iTerm2 <Text dimColor>(OSC 9)</Text>
        </Text>
      )
    case 'terminal_bell':
      return (
        <Text>
          Terminal Bell <Text dimColor>(\a)</Text>
        </Text>
      )
    case 'kitty':
      return (
        <Text>
          Kitty <Text dimColor>(OSC 99)</Text>
        </Text>
      )
    case 'ghostty':
      return (
        <Text>
          Ghostty <Text dimColor>(OSC 777)</Text>
        </Text>
      )
    case 'iterm2_with_bell':
      return 'iTerm2 w/ Bell'
    case 'notifications_disabled':
      return 'Disabled'
    default:
      return value
  }
}
