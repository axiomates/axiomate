import { feature } from 'bun:bundle'
import {
  EDITOR_MODES,
  NOTIFICATION_CHANNELS,
  TEAMMATE_MODES,
} from '../../utils/configConstants.js'
import { THEME_NAMES, THEME_SETTINGS } from '../../utils/theme.js'

/** AppState keys that can be synced for immediate UI effect */
type SyncableAppStateKey = 'verbose' | 'thinkingEnabled'

type SettingConfig = {
  source: 'global' | 'settings'
  type: 'boolean' | 'string' | 'number'
  description: string
  path?: string[]
  options?: readonly string[]
  getOptions?: () => string[]
  appStateKey?: SyncableAppStateKey
  /** Async validation called when writing/setting a value */
  validateOnWrite?: (v: unknown) => Promise<{ valid: boolean; error?: string }>
  /** Format value when reading/getting for display */
  formatOnRead?: (v: unknown) => unknown
  /** Inclusive numeric bounds. Only consulted when type === 'number'. */
  min?: number
  max?: number
}

export const SUPPORTED_SETTINGS: Record<string, SettingConfig> = {
  theme: {
    source: 'global',
    type: 'string',
    description: 'Color theme for the UI',
    options: feature('DEV') ? THEME_SETTINGS : THEME_NAMES,
  },
  editorMode: {
    source: 'global',
    type: 'string',
    description: 'Key binding mode',
    options: EDITOR_MODES,
  },
  verbose: {
    source: 'global',
    type: 'boolean',
    description: 'Show detailed debug output',
    appStateKey: 'verbose',
  },
  preferredNotifChannel: {
    source: 'global',
    type: 'string',
    description: 'Preferred notification channel',
    options: NOTIFICATION_CHANNELS,
  },
  autoCompactEnabled: {
    source: 'global',
    type: 'boolean',
    description: 'Auto-compact when context is full',
  },
  autoMemoryEnabled: {
    source: 'settings',
    type: 'boolean',
    description: 'Enable auto-memory',
  },
  autoDreamEnabled: {
    source: 'settings',
    type: 'boolean',
    description: 'Enable background memory consolidation',
  },
  fileCheckpointingEnabled: {
    source: 'global',
    type: 'boolean',
    description: 'Enable file checkpointing for code rewind',
  },
  checkpointsStatusRows: {
    source: 'global',
    type: 'number',
    description:
      'Default row count for `/checkpoints status` and `/checkpoints list` (CLI --rows overrides per call). Range 1..500.',
    min: 1,
    max: 500,
  },
  checkpointsMaxSnapshotsPerProject: {
    source: 'global',
    type: 'number',
    description:
      'Per-project snapshot cap. Both write-time ring buffer (createSnapshot) and prune-time snapshot-cap pass enforce this. 0 disables the cap entirely (size-cap still bounds total). Range 0..100000.',
    min: 0,
    max: 100_000,
  },
  checkpointsMaxFiles: {
    source: 'global',
    type: 'number',
    description:
      'Working-directory file-count cap for checkpoint snapshots. Snapshot creation skips before git add when this many files is exceeded. 0 disables this guard. Range 0..1000000.',
    min: 0,
    max: 1_000_000,
  },
  showTurnDuration: {
    source: 'global',
    type: 'boolean',
    description:
      'Show turn duration message after responses (e.g., "Cooked for 1m 6s")',
  },
  terminalProgressBarEnabled: {
    source: 'global',
    type: 'boolean',
    description: 'Show OSC 9;4 progress indicator in supported terminals',
  },
  todoFeatureEnabled: {
    source: 'global',
    type: 'boolean',
    description: 'Enable todo/task tracking',
  },
  alwaysThinkingEnabled: {
    source: 'settings',
    type: 'boolean',
    description: 'Enable extended thinking (false to disable)',
    appStateKey: 'thinkingEnabled',
  },
  'permissions.defaultMode': {
    source: 'settings',
    type: 'string',
    description: 'Default permission mode for tool usage',
    options: ['default', 'plan', 'acceptEdits', 'dontAsk'],
  },
  language: {
    source: 'settings',
    type: 'string',
    description:
      'Preferred language for Axiomate responses and voice dictation (e.g., "japanese", "spanish")',
  },
  teammateMode: {
    source: 'global',
    type: 'string',
    description:
      'How to spawn teammates: "tmux" for traditional tmux, "in-process" for same process, "auto" to choose automatically',
    options: TEAMMATE_MODES,
  },
  voiceEnabled: {
    source: 'settings',
    type: 'boolean',
    description: 'Enable voice dictation (hold-to-talk)',
  },
  bashAstEnabled: {
    source: 'settings',
    type: 'boolean',
    description:
      'Use tree-sitter AST parser for bash permission checks (stricter)',
  },
  sessionMemoryEnabled: {
    source: 'settings',
    type: 'boolean',
    description:
      'Periodically extract conversation notes to MEMORY.md (forked agent)',
  },
  extractMemoriesEnabled: {
    source: 'settings',
    type: 'boolean',
    description:
      'At end of every turn, forked agent distills facts into daily memory logs',
  },
  awaySummaryEnabled: {
    source: 'settings',
    type: 'boolean',
    description:
      'Generate "while you were away" recap using the awaySummary auxiliary route on focus regain > 5 min',
  },
  builtInAgentsEnabled: {
    source: 'settings',
    type: 'boolean',
    description:
      'Register built-in Explore / Plan / Verification agents (Verification forces pre-completion check)',
  },
  messageActionsEnabled: {
    source: 'settings',
    type: 'boolean',
    description:
      'shift+up to edit/copy past messages (Enter/C/P in the mode menu)',
  },
  globalSearchEnabled: {
    source: 'settings',
    type: 'boolean',
    description:
      'Advanced search dialogs: Ctrl+Shift+P quick open, Ctrl+Shift+F global search, Ctrl+R modal history',
  },
}

export function isSupported(key: string): boolean {
  return key in SUPPORTED_SETTINGS
}

export function getConfig(key: string): SettingConfig | undefined {
  return SUPPORTED_SETTINGS[key]
}

export function getAllKeys(): string[] {
  return Object.keys(SUPPORTED_SETTINGS)
}

export function getOptionsForSetting(key: string): string[] | undefined {
  const config = SUPPORTED_SETTINGS[key]
  if (!config) return undefined
  if (config.options) return [...config.options]
  if (config.getOptions) return config.getOptions()
  return undefined
}

export function getPath(key: string): string[] {
  const config = SUPPORTED_SETTINGS[key]
  return config?.path ?? key.split('.')
}
