import { useEffect, useRef } from 'react'
import {
  type FileHistorySnapshot,
  type FileHistoryState,
  fileHistoryEnabled,
  fileHistoryRestoreStateFromLog,
} from '../utils/fileHistory.js'
import { logForDebugging } from '../utils/debug.js'

export function useFileHistorySnapshotInit(
  initialFileHistorySnapshots: FileHistorySnapshot[] | undefined,
  fileHistoryState: FileHistoryState,
  onUpdateState: (newState: FileHistoryState) => void,
): void {
  const initialized = useRef(false)

  useEffect(() => {
    logForDebugging(
      `useFileHistorySnapshotInit: fire enabled=${fileHistoryEnabled()} ` +
        `initialized=${initialized.current} ` +
        `initialSnapshots=${initialFileHistorySnapshots?.length ?? 'undefined'} ` +
        `currentState.snapshotMessageIds=${fileHistoryState.snapshotMessageIds.size}`,
    )
    if (!fileHistoryEnabled() || initialized.current) {
      return
    }
    initialized.current = true
    if (initialFileHistorySnapshots) {
      logForDebugging(
        `useFileHistorySnapshotInit: calling fileHistoryRestoreStateFromLog with ` +
          `${initialFileHistorySnapshots.length} snapshots`,
      )
      fileHistoryRestoreStateFromLog(initialFileHistorySnapshots, onUpdateState)
    }
  }, [fileHistoryState, initialFileHistorySnapshots, onUpdateState])
}
