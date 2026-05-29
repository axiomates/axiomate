import { feature } from 'bun:bundle'
import { setMainLoopModelOverride } from '../bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { toError } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import { applyConfigEnvironmentVariables } from '../utils/managedEnv.js'
import { persistMainRoutePrimary } from '../utils/model/modelRoutePersistence.js'
import { defaultRouteOverride } from '../utils/model/model.js'
import {
  permissionModeFromString,
  toExternalPermissionMode,
} from '../utils/permissions/PermissionMode.js'
import {
  notifyPermissionModeChanged,
  notifySessionMetadataChanged,
  type SessionExternalMetadata,
} from '../utils/sessionState.js'
import type { AppState } from './AppStateStore.js'

// Inverse of the push below — restore on worker restart.
export function externalMetadataToAppState(
  metadata: SessionExternalMetadata,
): (prev: AppState) => AppState {
  return prev => ({
    ...prev,
    ...(typeof metadata.permission_mode === 'string'
      ? {
          toolPermissionContext: {
            ...prev.toolPermissionContext,
            mode: permissionModeFromString(metadata.permission_mode),
          },
        }
      : {}),
  })
}

export function onChangeAppState({
  newState,
  oldState,
}: {
  newState: AppState
  oldState: AppState
}) {
  // toolPermissionContext.mode — single choke point for mode-change listeners.
  //
  // Every path that mutates toolPermissionContext.mode (Shift+Tab cycling,
  // ExitPlanModePermissionRequest dialog options, /plan slash command,
  // set_permission_mode control request, rewind, etc.) eventually calls
  // setAppState, so hooking the diff here delivers one consistent signal
  // to the registered listeners — no matter which callsite did the mutation.
  const prevMode = oldState.toolPermissionContext.mode
  const newMode = newState.toolPermissionContext.mode
  if (prevMode !== newMode) {
    // Internal-only mode names (bubble, ungated auto) must be externalized
    // before delivery to metadata consumers, and we skip the metadata notify
    // if the EXTERNAL mode didn't change (e.g., default→bubble→default is
    // noise — both externalize to 'default'). The permission-mode channel
    // (notifyPermissionModeChanged) passes the raw mode; its listener
    // applies its own filter.
    const prevExternal = toExternalPermissionMode(prevMode)
    const newExternal = toExternalPermissionMode(newMode)
    if (prevExternal !== newExternal) {
      notifySessionMetadataChanged({
        permission_mode: newExternal,
      })
    }
    notifyPermissionModeChanged(newMode)
  }

  // mainLoopModel: reset to the persisted default route for future sessions.
  if (
    newState.mainLoopModel !== oldState.mainLoopModel &&
    newState.mainLoopModel === null
  ) {
    setMainLoopModelOverride(defaultRouteOverride())
  }

  // mainLoopModel: persist ordinary model switches by updating the configured
  // default route primary in ~/.axiomate.json.
  if (
    newState.mainLoopModel !== oldState.mainLoopModel &&
    newState.mainLoopModel !== null
  ) {
    persistMainRoutePrimary(newState.mainLoopModel)
    setMainLoopModelOverride(undefined)
  }

  // Session override: explicit request-local route override. This never
  // persists model.defaultRoute or route contents; it only informs non-React
  // runtime helpers that read bootstrap state.
  if (
    newState.mainLoopModelOverrideForSession !==
    oldState.mainLoopModelOverrideForSession
  ) {
    setMainLoopModelOverride(newState.mainLoopModelOverrideForSession)
  }

  // expandedView → persist as showExpandedTodos + showSpinnerTree for backwards compat
  if (newState.expandedView !== oldState.expandedView) {
    const showExpandedTodos = newState.expandedView === 'tasks'
    const showSpinnerTree = newState.expandedView === 'teammates'
    if (
      getGlobalConfig().showExpandedTodos !== showExpandedTodos ||
      getGlobalConfig().showSpinnerTree !== showSpinnerTree
    ) {
      saveGlobalConfig(current => ({
        ...current,
        showExpandedTodos,
        showSpinnerTree,
      }))
    }
  }

  // verbose
  if (
    newState.verbose !== oldState.verbose &&
    getGlobalConfig().verbose !== newState.verbose
  ) {
    const verbose = newState.verbose
    saveGlobalConfig(current => ({
      ...current,
      verbose,
    }))
  }

  // tungstenPanelVisible (DEV-only tmux panel sticky toggle)
  if (feature('DEV')) {
    if (
      newState.tungstenPanelVisible !== oldState.tungstenPanelVisible &&
      newState.tungstenPanelVisible !== undefined &&
      getGlobalConfig().tungstenPanelVisible !== newState.tungstenPanelVisible
    ) {
      const tungstenPanelVisible = newState.tungstenPanelVisible
      saveGlobalConfig(current => ({ ...current, tungstenPanelVisible }))
    }
  }

  // settings: re-apply environment variables when settings.env changes
  // This is additive-only: new vars are added, existing may be overwritten, nothing is deleted
  if (newState.settings !== oldState.settings) {
    try {
      if (newState.settings.env !== oldState.settings.env) {
        applyConfigEnvironmentVariables()
      }
    } catch (error) {
      logError(toError(error))
    }
  }
}
