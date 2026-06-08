/**
 * `/checkpoints clear` confirm dialog. Renders a Yes/No `Select` after
 * a one-paragraph "this is destructive" header. On confirm runs
 * `clearAll`; on cancel returns to the REPL with no side effects.
 *
 * Kept in its own component so the rest of `/checkpoints` stays as a
 * pure text path that can shell out to `onDone(string)` immediately —
 * matches Hermes' `cmd_clear` interactive prompt
 * (`hermes_cli/checkpoints.py::cmd_clear`).
 */

import React, { useState } from 'react'
import { Box, Text } from '../../ink.js'
import { Select } from '../../components/CustomSelect/select.js'
import { clearAll } from '../../utils/checkpoints/clearAll.js'
import { storeStatus } from '../../utils/checkpoints/storeStatus.js'
import { formatBytes } from './format.js'

type Mode = 'confirm' | 'running' | 'done'

export interface ClearViewProps {
  base: string
  initialBytes: number
  onDone: (msg?: string) => void
}

const YES = 'yes'
const NO = 'no'
const OPTIONS = [
  { label: 'No, keep checkpoints', value: NO },
  { label: 'Yes, delete everything', value: YES },
]

export function ClearView({
  base,
  initialBytes,
  onDone,
}: ClearViewProps): React.ReactElement {
  const [mode, setMode] = useState<Mode>('confirm')
  const [result, setResult] = useState<string>('')

  const onChange = async (value: string) => {
    if (value === NO) {
      onDone('Cancelled. Checkpoint store is unchanged.')
      return
    }
    setMode('running')
    const report = await clearAll()
    const tempSummary = report.rewind_temp_dirs_removed > 0
      ? `\nRemoved ${report.rewind_temp_dirs_removed} rewind temp ${report.rewind_temp_dirs_removed === 1 ? 'directory' : 'directories'} (${formatBytes(report.rewind_temp_bytes_freed)}).`
      : ''
    if (report.deleted) {
      const summary =
        `Cleared ${formatBytes(report.bytes_freed)} from ${base}.\n` +
        `The store will be re-created on the next snapshot.` +
        tempSummary
      setResult(summary)
      onDone(summary)
    } else {
      const head =
        report.errors.length === 0
          ? report.rewind_temp_dirs_removed > 0
            ? `No checkpoint store found at ${base}.`
            : `Nothing to clear at ${base}.`
          : `Could not clear ${base} (${formatBytes(report.bytes_freed)} on disk).`
      const detail = report.errors.map(e => `  - ${e}`).join('\n')
      const out = detail ? `${head}${tempSummary}\n${detail}` : `${head}${tempSummary}`
      setResult(out)
      onDone(out)
    }
    setMode('done')
  }

  if (mode === 'confirm') {
    return (
      <Box flexDirection="column">
        <Text bold>Delete all checkpoints?</Text>
        <Text>
          This removes <Text bold>{base}</Text> and frees{' '}
          {formatBytes(initialBytes)}. Snapshots from past sessions cannot be
          recovered. New snapshots will rebuild the store from scratch.
        </Text>
        <Text> </Text>
        <Select options={OPTIONS} onChange={onChange} onCancel={() => onDone('Cancelled. Checkpoint store is unchanged.')} />
      </Box>
    )
  }
  if (mode === 'running') {
    return <Text>Clearing checkpoint store...</Text>
  }
  return <Text>{result}</Text>
}

/**
 * Entry point used by `checkpoints.tsx` — measures the store size first
 * so the confirm copy is concrete ("free 47 MB") rather than vague.
 */
export async function startClearFlow(
  onDone: (msg?: string) => void,
): Promise<React.ReactElement> {
  const status = await storeStatus()
  return (
    <ClearView
      base={status.base}
      initialBytes={status.total_size_bytes}
      onDone={onDone}
    />
  )
}
