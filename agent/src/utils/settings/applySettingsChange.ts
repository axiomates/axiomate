import type { AppState } from '../../state/AppState.js'
import { logForDebugging } from '../debug.js'
import { updateHooksConfigSnapshot } from '../hooks/hooksConfigSnapshot.js'
import { syncPermissionRulesFromDisk } from '../permissions/permissions.js'
import { loadAllPermissionRulesFromDisk } from '../permissions/permissionsLoader.js'
import type { SettingSource } from './constants.js'
import { getInitialSettings } from './settings.js'

/**
 * Apply a settings change to app state. Re-reads settings from disk,
 * reloads permissions and hooks, and pushes the new state.
 *
 * Used by both the interactive path (AppState.tsx via useSettingsChange) and
 * the headless/SDK path (print.ts direct subscribe) so that managed-settings
 * / policy changes are fully applied in both modes.
 *
 * The settings cache is reset by the notifier (changeDetector.fanOut) before
 * listeners are iterated, so getInitialSettings() here reads fresh disk
 * state. Previously this function reset the cache itself, which — combined
 * with useSettingsChange's own reset — caused N disk reloads per notification
 * for N subscribers.
 *
 * Side-effects like clearing auth caches and applying env vars are handled by
 * `onChangeAppState` which fires when `settings` changes in state.
 */
export function applySettingsChange(
  source: SettingSource,
  setAppState: (f: (prev: AppState) => AppState) => void,
): void {
  const newSettings = getInitialSettings()

  logForDebugging(`Settings changed from ${source}, updating app state`)

  const updatedRules = loadAllPermissionRulesFromDisk()
  updateHooksConfigSnapshot()

  setAppState(prev => {
    const newContext = syncPermissionRulesFromDisk(
      prev.toolPermissionContext,
      updatedRules,
    )

    // Sync effortByModel from settings to top-level AppState when it changes
    // (e.g. via applyFlagSettings from IDE). Only propagate if the dict
    // itself changed — otherwise unrelated settings churn (e.g. tips dismissal
    // on startup) would clobber a session-scoped value held in
    // effortValueByModel.
    const prevByModel = prev.settings.effortByModel ?? {}
    const newByModel = newSettings.effortByModel ?? {}
    const byModelChanged = !shallowDictEqual(prevByModel, newByModel)

    return {
      ...prev,
      settings: newSettings,
      spinnerTip:
        newSettings.spinnerTipsEnabled === false ? undefined : prev.spinnerTip,
      toolPermissionContext: newContext,
      // When the disk dict changes, replace AppState's dict — but preserve
      // session-only entries (--effort flag, runtime overrides) that aren't
      // on disk. Merge: session entries win unless the disk added/changed
      // a specific model's entry. Simpler: just adopt the new disk dict and
      // overlay any unsaved session entries on top.
      ...(byModelChanged
        ? {
            effortValueByModel: {
              ...newByModel,
              // Preserve session-only entries (those whose value differs
              // from disk because they were set via setAppState directly,
              // not through updateSettingsForSource).
              ...Object.fromEntries(
                Object.entries(prev.effortValueByModel ?? {}).filter(
                  ([k, v]) =>
                    prevByModel[k] !== v && newByModel[k] === undefined,
                ),
              ),
            },
          }
        : {}),
    }
  })
}

function shallowDictEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    if (a[k] !== b[k]) return false
  }
  return true
}
