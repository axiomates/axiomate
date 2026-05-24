import type {
  ContentBlockParam,
  TextBlockParam,
} from '../services/api/streamTypes.js'
import { randomUUID, type UUID } from 'crypto'
import figures from 'figures'
import * as React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  logEvent,
} from '../services/analytics/index.js'
import {
  type DiffStats,
  bulkDiffEventStats,
  fileHistoryBulkDiffVsDisk,
  fileHistoryEnabled,
  fileHistoryGetDiffVsDisk,
} from '../utils/fileHistory.js'
import {
  type CodeAnchor,
  listCodeAnchors,
} from '../utils/checkpoints/listCodeAnchors.js'
import {
  classifyAnchor,
  parseCommitBody,
} from '../utils/checkpoints/reason.js'
import {
  decrementPickerOpenCount,
  getOriginalCwd,
  incrementPickerOpenCount,
} from '../bootstrap/state.js'
import { logError } from '../utils/log.js'
import { logForDebugging } from '../utils/debug.js'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { Box, Text } from '../ink.js'
import { useKeybinding, useKeybindings } from '../keybindings/useKeybinding.js'
import type {
  Message,
  PartialCompactDirection,
  UserMessage,
} from '../types/message.js'
import { stripDisplayTags } from '../utils/displayTags.js'
import {
  createUserMessage,
  extractTag,
  isEmptyMessageText,
  isSyntheticMessage,
  isToolUseResultMessage,
} from '../utils/messages.js'
import { type OptionWithDescription, Select } from './CustomSelect/select.js'
import { Spinner } from './Spinner.js'

function isTextBlock(block: ContentBlockParam): block is TextBlockParam {
  return block.type === 'text'
}

import * as path from 'path'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import {
  BASH_STDERR_TAG,
  BASH_STDOUT_TAG,
  COMMAND_MESSAGE_TAG,
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
  TASK_NOTIFICATION_TAG,
  TEAMMATE_MESSAGE_TAG,
  TICK_TAG,
} from '../constants/xml.js'
import { count } from '../utils/array.js'
import { formatRelativeTimeAgo, truncate } from '../utils/format.js'
import type { Theme } from '../utils/theme.js'
import { Divider } from './design-system/Divider.js'

type RestoreOption =
  | 'conversation'
  | 'file'
  | 'summarize'
  | 'summarize_up_to'
  | 'nevermind'

function isSummarizeOption(
  option: RestoreOption | null,
): option is 'summarize' | 'summarize_up_to' {
  return option === 'summarize' || option === 'summarize_up_to'
}

type Props = {
  messages: Message[]
  onPreRestore: () => void
  onRestoreMessage: (
    message: UserMessage,
    mode?: 'conversation-only',
  ) => Promise<void>
  onRestoreCode: (
    message: UserMessage,
    mode?: 'file-only',
  ) => Promise<void>
  onSummarize: (
    message: UserMessage,
    feedback?: string,
    direction?: PartialCompactDirection,
  ) => Promise<void>
  onClose: () => void
  /** Skip pick-list, land on confirm. Caller ran skip-check first. Esc closes fully (no back-to-list). */
  preselectedMessage?: UserMessage
}

const MAX_VISIBLE_MESSAGES = 7

export function MessageSelector({
  messages,
  onPreRestore,
  onRestoreMessage,
  onRestoreCode,
  onSummarize,
  onClose,
  preselectedMessage,
}: Props): React.ReactNode {
  const [error, setError] = useState<string | undefined>(undefined)
  const isFileHistoryEnabled = fileHistoryEnabled()

  // Add current prompt as a virtual message
  const currentUUID = useMemo(randomUUID, [])

  // Two-view picker:
  //   default      — only turns where the AI actually edited files
  //                  (a snapshot exists keyed to that turn's UUID).
  //                  Every row offers code+conversation+both rewind.
  //   Tab toggle   — every selectable user turn (slash, readonly, prose),
  //                  for conversation-only rewind to a non-edit anchor.
  // CRITICAL INVARIANT (don't break): the filter chain below MUST keep
  // the original message object references. Rewind handlers downstream
  // call `messages.lastIndexOf(message)` and resolve by `message.uuid`
  // against the full `messages` array, so the picker filter is purely
  // cosmetic. `Array.filter` preserves identity — never `map` here.
  // Phase 3: Tab key now switches between two semantically distinct
  // rewind modes (was: a row-filter toggle that left chooser options
  // unchanged, which left users guessing what Tab did). After this
  // change Tab maps to "what kind of rewind am I doing?":
  //   - 'code' (default): row set = anchors + ↶ rows; chooser offers
  //     code restore and the "code + conversation" combined option;
  //     this is the persistent rewind regime backed by the git store.
  //   - 'conversation': row set = every selectable user message,
  //     no ↶ rows; chooser offers conversation restore and summarize;
  //     this is the in-memory regime (current-session only) — note
  //     surfaced at the top of the picker so users see the asymmetry
  //     before they pick.
  // Mode and view stay coupled: visible rows match what the chooser
  // can do for them. Earlier the visible row set and the chooser
  // options were independent, leading to "selected this row, why
  // does the chooser say I can't?" confusion.
  const [activeTab, setActiveTab] = useState<'code' | 'conversation'>(
    'code',
  )
  const allSelectable = useMemo(
    () => messages.filter(selectableUserMessagesFilter),
    [messages],
  )

  // Anchors come from git (the shadow checkpoint store) — single source
  // of truth for "what code anchors exist". Picker fetches once on mount;
  // re-mounts after rewind / clear / prune naturally pull fresh state.
  const [anchors, setAnchors] = useState<readonly CodeAnchor[]>([])
  const [anchorsLoaded, setAnchorsLoaded] = useState(false)
  // Tracks whether the per-anchor diff-vs-disk fetch has completed.
  // Distinct from anchorsLoaded so the picker can render a brief
  // "reading diff…" placeholder for the ~80-150ms gap between
  // listCodeAnchors returning and bulkDiffVsDisk returning. Without
  // this gate, rows momentarily render ⚠ ("no anchor / cannot
  // restore") even though the anchor exists and the data is in flight.
  const [bulkLoaded, setBulkLoaded] = useState(false)

  // Process-wide picker-open count. Background housekeeping skips
  // pruneCheckpoints while > 0 so anchors the picker is showing
  // can't disappear out from under the user. Empty deps array
  // makes the pair balanced across the component lifetime — one
  // increment on mount, one decrement on unmount, nothing in
  // between can re-trigger the effect.
  useEffect(() => {
    incrementPickerOpenCount()
    return () => {
      decrementPickerOpenCount()
    }
  }, [])

  useEffect(() => {
    if (!isFileHistoryEnabled) {
      setAnchorsLoaded(true)
      return
    }
    let cancelled = false
    // withStats: true is required so each CodeAnchor carries its
    // commit-vs-parent numstat (insertions/deletions/filePaths).
    // bulkDiffEventStats reads those fields directly — without them
    // every row falls back to "(no diff)" / "No code changes" even
    // though /checkpoints list (which already passes withStats:true)
    // shows real numbers. Setting it false here was a leftover from
    // when the picker computed anchor-vs-disk per row.
    void listCodeAnchors(getOriginalCwd(), {
      withStats: true,
      withBodies: true,
    })
      .then(rows => {
        if (cancelled) return
        logForDebugging(
          `MessageSelector: [Anchors] loaded ${rows.length}: ` +
            rows
              .map(
                r =>
                  `${r.gitHash.slice(0, 8)}(msg=${r.messageId?.slice(0, 8) ?? 'raw'}, +${r.insertions}/-${r.deletions}, files=${r.filesChanged})`,
              )
              .join(' '),
        )
        setAnchors(rows)
        setAnchorsLoaded(true)
      })
      .catch(err => {
        if (cancelled) return
        logError(err)
        setAnchorsLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [isFileHistoryEnabled])

  const anchorByMsgId = useMemo(() => {
    const m = new Map<UUID, CodeAnchor>()
    for (const a of anchors) {
      if (a.messageId) m.set(a.messageId, a)
    }
    return m
  }, [anchors])

  const hasAnySnapshot = isFileHistoryEnabled && anchors.length > 0
  // Code tab: rows with a code anchor (or ↶ synthetic anchors). When
  // no anchors exist at all (fresh project or post-/checkpoints
  // clear), show an empty list rather than a polluted view of every
  // user message marked ⚠ — that earlier fallback was misleading.
  // The empty-list footer instructs the user to Tab to the
  // conversation tab if they need conversation-only rewind.
  // Conversation tab: every selectable user message — restore
  // conversation works without an anchor.
  const visibleSelectable = useMemo(
    () => {
      if (activeTab === 'conversation') return allSelectable
      if (!hasAnySnapshot) return [] // Code tab + no anchors = empty
      return allSelectable.filter(m => anchorByMsgId.has(m.uuid))
    },
    [allSelectable, activeTab, anchorByMsgId, hasAnySnapshot],
  )
  const hiddenCount = allSelectable.length - visibleSelectable.length

  // Diagnostic: log the picker's filter inputs whenever they change so
  // /resume-path or filter-mismatch bugs leave a paper trail. Crucially,
  // tracks state.snapshots / messages / syntheticAnchors as deps — if
  // snapshots load asynchronously (e.g. from JSONL on resume), we get
  // a snapshot of state at each transition, not just at mount.
  // Placed AFTER syntheticAnchors so we can include its computed value.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional

  // Snapshots can come in with `timestamp` as a real Date (created in-
  // process via `new Date()`) OR as a string (loaded from JSONL via
  // /resume / fork — JSON.parse turns Dates into ISO strings, no revive
  // step). Defend both at the read site instead of rebuilding the
  // restore pipeline; picker is the only consumer that compares them.
  const snapshotTimeMs = (ts: Date | string | number): number => {
    if (typeof ts === 'number') return ts
    if (typeof ts === 'string') return Date.parse(ts) || 0
    if (ts instanceof Date) return ts.getTime()
    return 0
  }
  const formatSnapshotTime = (ts: Date | string | number): string => {
    const ms = snapshotTimeMs(ts)
    return new Date(ms).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  // Synthetic anchor rows for snapshots whose messageId is NOT in the
  // conversation `messages` array — i.e. pre-rewind safety snapshots
  // (and any future system-synthesized anchors). These rows let the
  // user undo a rewind by selecting a `pre-rewind:*` row in the picker.
  // They are pure UserMessage-shaped objects (same shape as the
  // `(current)` row below) so the rest of the picker pipeline treats
  // them uniformly. `handleSelect` later branches via
  // `messages.includes(message)` to route to code-only restore.
  const conversationUuids = useMemo(
    () => new Set(messages.map(m => m.uuid)),
    [messages],
  )
  const syntheticAnchors = useMemo<UserMessage[]>(() => {
    if (!isFileHistoryEnabled) return []
    // ↶ rows belong to the code tab only. Conversation rewind on a
    // synthetic anchor is meaningless — its messageId isn't in the
    // active conversation chain, so there's nothing to truncate to.
    if (activeTab !== 'code') return []
    // Sort orphan anchors oldest→newest so the chronological merge
    // below (in messageOptions) places them in real time order.
    // anchors arrives newest-first from listCodeAnchors; without this
    // explicit sort, two synthetic rows with adjacent timestamps end
    // up reversed in the picker (a 16:14 pre-rewind row above its
    // 16:13 abandoned-turn row, etc.). The merge loop's comparator
    // only handles real-vs-synth ordering, not synth-vs-synth.
    const sortedOrphans = anchors
      .filter(a => a.messageId !== undefined && !conversationUuids.has(a.messageId))
      .slice()
      .sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      )
    return sortedOrphans
      .map(a => {
        const time = formatSnapshotTime(a.timestamp)
        // Three-template label. Pre-rewind safety nets get a distinct
        // "Undo rewind to ..." prefix so users can tell at a glance
        // which row would undo a rewind vs which row is just an
        // abandoned-fork orphan from a turn that got skipped — both
        // can carry the same prompt preview text in their body
        // (because both reference the same prompt — one as "rewound
        // past it", the other as "rewound to before it"), and the
        // diff-stats column alone wasn't enough disambiguation in
        // sandbox testing.
        //
        //   ↶ Undo rewind to "<X>" (HH:MM)  — pre-rewind safety net
        //   ↶ "<X>" (HH:MM)                  — abandoned turn anchor
        //   ↶ Off-branch anchor (HH:MM)      — no body preview
        //
        // /checkpoints list uses the same prefix via formatAnchorReason
        // — single source of truth in reason.ts.
        const role = classifyAnchor(a.subject)
        const parsedBody = parseCommitBody(a.body)
        let preview: string | undefined
        if (parsedBody.kind === 'prompt' || parsedBody.kind === 'target') {
          if (parsedBody.preview.length > 0) preview = parsedBody.preview
        } else if (parsedBody.kind === 'unknown' && parsedBody.raw.length > 0) {
          // Legacy bodies (pre-codec) stored a free-form preview
          // without a key. Render them like any other preview.
          preview = parsedBody.raw
        }
        let content: string
        if (preview) {
          content =
            role === 'pre-rewind'
              ? `↶ Rewind to before "${preview}" (${time})`
              : `↶ Before "${preview}" (${time})`
        } else {
          content = `↶ Off-branch anchor (${time})`
        }
        return {
          ...createUserMessage({ content }),
          uuid: a.messageId!,
        } as UserMessage
      })
  }, [anchors, conversationUuids, isFileHistoryEnabled, activeTab])

  // Diagnostic: tracks state.snapshots / messages / syntheticAnchors
  // across re-renders so resume-path and filter-mismatch bugs leave a
  // paper trail. If snapshots load asynchronously (JSONL on resume),
  // we capture each transition, not just the initial mount.
  useEffect(() => {
    if (!isFileHistoryEnabled) return
    const anchorMatches = allSelectable.filter(m => anchorByMsgId.has(m.uuid))
    const orphanIds = anchors
      .filter(a => a.messageId !== undefined && !messages.some(m => m.uuid === a.messageId))
      .map(a => a.messageId!.slice(0, 8))
    const synthIds = syntheticAnchors.map(s => s.uuid.slice(0, 8))
    logForDebugging(
      `MessageSelector: [Picker] state messages=${messages.length} ` +
        `allSelectable=${allSelectable.length} anchors=${anchors.length} ` +
        `anchors-in-conversation=${anchorMatches.length} ` +
        `orphan-anchors=[${orphanIds.join(',')}] ` +
        `syntheticAnchors=[${synthIds.join(',')}]`,
    )
  }, [
    isFileHistoryEnabled,
    messages,
    allSelectable,
    anchors,
    anchorByMsgId,
    syntheticAnchors,
  ])

  const messageOptions = useMemo(() => {
    // Merge synthetic anchors into the conversation row list by
    // chronological order. Both inputs are pre-sorted (state.snapshots
    // is append-only chronological; visibleSelectable preserves
    // messages array order). Single-pass O(n) merge using each row's
    // associated snapshot timestamp as the key. Real rows look up
    // their timestamp via state.snapshots; if a row has no snapshot
    // (e.g. all-turns view shows readonly rows), it sorts by its
    // message position relative to neighboring snapshotted rows —
    // implemented as "assign the timestamp of the most recent
    // preceding snapshotted row, or 0 for rows before any snapshot".
    const tsByUuid = new Map<UUID, number>()
    for (const a of anchors) {
      if (a.messageId) tsByUuid.set(a.messageId, snapshotTimeMs(a.timestamp))
    }
    let lastTs = 0
    const realRowsWithTs = visibleSelectable.map(m => {
      const ts = tsByUuid.get(m.uuid)
      if (ts !== undefined) lastTs = ts
      return { row: m, ts: lastTs }
    })
    const synthRowsWithTs = syntheticAnchors.map(m => {
      const ts = tsByUuid.get(m.uuid) ?? 0
      return { row: m, ts }
    })
    // Stable merge — when timestamps tie, real rows come first so
    // a pre-rewind anchor produced *during* a turn renders right
    // after that turn's row, not before it.
    let i = 0
    let j = 0
    const merged: UserMessage[] = []
    while (i < realRowsWithTs.length && j < synthRowsWithTs.length) {
      if (realRowsWithTs[i]!.ts <= synthRowsWithTs[j]!.ts) {
        merged.push(realRowsWithTs[i]!.row)
        i++
      } else {
        merged.push(synthRowsWithTs[j]!.row)
        j++
      }
    }
    while (i < realRowsWithTs.length) merged.push(realRowsWithTs[i++]!.row)
    while (j < synthRowsWithTs.length) merged.push(synthRowsWithTs[j++]!.row)

    return [
      ...merged,
      {
        ...createUserMessage({
          content: '',
        }),
        uuid: currentUUID,
      } as UserMessage,
    ]
  }, [visibleSelectable, syntheticAnchors, anchors, currentUUID])
  const [selectedIndex, setSelectedIndex] = useState(messageOptions.length - 1)

  // When toggling the slash filter, anchor focus by UUID so the user
  // stays on the same semantic message across the transition. If the
  // currently focused entry is being hidden (it was a slash and we
  // just hid them), clamp to the nearest valid index instead.
  // Two-phase: capture the UUID at toggle time, resolve in an effect
  // because messageOptions only updates on the next render.
  const [pendingFocusUuid, setPendingFocusUuid] = useState<string | null>(null)
  useEffect(() => {
    if (pendingFocusUuid === null) return
    const idx = messageOptions.findIndex(m => m.uuid === pendingFocusUuid)
    setSelectedIndex(prev =>
      idx >= 0 ? idx : Math.min(prev, messageOptions.length - 1),
    )
    setPendingFocusUuid(null)
  }, [messageOptions, pendingFocusUuid])

  // Orient the selected message as the middle of the visible options
  const firstVisibleIndex = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(MAX_VISIBLE_MESSAGES / 2),
      messageOptions.length - MAX_VISIBLE_MESSAGES,
    ),
  )

  const hasMessagesToSelect = messageOptions.length > 1

  const [messageToRestore, setMessageToRestore] = useState<
    UserMessage | undefined
  >(preselectedMessage)
  const [diffStatsForRestore, setDiffStatsForRestore] = useState<
    DiffStats | undefined
  >(undefined)

  useEffect(() => {
    if (!preselectedMessage || !isFileHistoryEnabled) return
    let cancelled = false
    const anchor = anchorByMsgId.get(preselectedMessage.uuid)
    if (!anchor) {
      setDiffStatsForRestore(undefined)
      return
    }
    void fileHistoryGetDiffVsDisk(anchor.gitHash).then(stats => {
      if (!cancelled) setDiffStatsForRestore(stats)
    })
    return () => {
      cancelled = true
    }
  }, [preselectedMessage, isFileHistoryEnabled, anchorByMsgId])

  const [isRestoring, setIsRestoring] = useState(false)
  const [restoringOption, setRestoringOption] = useState<RestoreOption | null>(
    null,
  )
  const [selectedRestoreOption, setSelectedRestoreOption] =
    useState<RestoreOption>('file')
  // Per-option feedback state; Select's internal inputValues Map persists
  // per-option text independently, so sharing one variable would desync.
  const [summarizeFromFeedback, setSummarizeFromFeedback] = useState('')
  const [summarizeUpToFeedback, setSummarizeUpToFeedback] = useState('')

  // Generate options with summarize as input type for inline context.
  // `isSynthetic` is set when the selected row is a system-synthesized
  // anchor (pre-rewind safety snapshot or abandoned-fork orphan) —
  // those have no conversation to fork, so conversation-restore
  // actions are meaningless, and code-restore is only offered when
  // the anchor actually differs from current disk.
  //
  // Tab governs row visibility, NOT chooser options. Once a row is
  // picked, all rewind actions valid for that row are offered:
  //   - Code tab + regular row + diff: code / conversation / both
  //   - Code tab + regular row + no diff: conversation only
  //   - Code tab + ↶ row + diff: code only
  //   - Code tab + ↶ row + no diff: nothing actionable (caller
  //     filters those rows out before chooser opens)
  //   - Conversation tab + any row: Restore conversation + Summarize
  //
  // Consistency contract: if Restore code is in the option list,
  // executing it MUST change disk. canRestoreCode is computed from
  // the same anchor-vs-disk diff fileHistoryRewind will run, so a
  // disk-matching anchor never reaches the chooser with Restore
  // code as a real option.
  function getRestoreOptions(
    canRestoreCode: boolean,
    isSynthetic: boolean = false,
  ): OptionWithDescription<RestoreOption>[] {
    if (isSynthetic) {
      // Synthetic ↶ rows have no conversation chain to truncate to;
      // only Restore code makes sense — and only when the anchor
      // actually differs from disk. The picker should already have
      // filtered no-diff synthetic rows out, but gate here too in
      // case the disk changed between picker open and chooser open.
      const opts: OptionWithDescription<RestoreOption>[] = []
      if (canRestoreCode) {
        opts.push({ value: 'file', label: 'Restore file' })
      }
      opts.push({ value: 'nevermind', label: 'Never mind' })
      return opts
    }

    let baseOptions: OptionWithDescription<RestoreOption>[]
    if (activeTab === 'code') {
      // 'both' (Restore file and conversation) was removed: it created
      // an asymmetric undo state. The file rewind half writes a
      // persistent pre-rewind anchor (recoverable via "↶ Undo last
      // rewind"); the conversation rewind half is an in-memory
      // messages.slice() with no JSONL record. Selecting the ↶ row
      // afterward only undoes the file half. Worse, /resume reloads
      // JSONL and silently restores the truncated conversation while
      // disk stays at the rewound state — half the operation reverts
      // by accident, the other half permanently.
      //
      // Two explicit steps (Restore file, then Restore conversation)
      // make the asymmetry visible: each click corresponds to one
      // axis the user understands. Once #188 (conversation rewind
      // persistence) lands, 'both' can come back as a real symmetric
      // operation.
      baseOptions = canRestoreCode
        ? [
            { value: 'file', label: 'Restore file' },
            { value: 'conversation', label: 'Restore conversation' },
          ]
        : [{ value: 'conversation', label: 'Restore conversation' }]
    } else {
      baseOptions = [{ value: 'conversation', label: 'Restore conversation' }]
    }

    const summarizeInputProps = {
      type: 'input' as const,
      placeholder: 'add context (optional)',
      initialValue: '',
      allowEmptySubmitToCancel: true,
      showLabelWithValue: true,
      labelValueSeparator: ': ',
    }
    if (activeTab === 'conversation') {
      baseOptions.push({
        value: 'summarize',
        label: 'Summarize from here',
        ...summarizeInputProps,
        onChange: setSummarizeFromFeedback,
      })
    }

    baseOptions.push({ value: 'nevermind', label: 'Never mind' })
    return baseOptions
  }

  // Log when selector is opened
  useEffect(() => {
  }, [])

  // Helper to restore conversation without confirmation
  async function restoreConversationDirectly(message: UserMessage) {
    onPreRestore()
    setIsRestoring(true)
    try {
      await onRestoreMessage(message, 'conversation-only')
      setIsRestoring(false)
      onClose()
    } catch (error) {
      logError(error as Error)
      setIsRestoring(false)
      setError(`Failed to restore the conversation:\n${error}`)
    }
  }

  async function handleSelect(message: UserMessage) {
    // (current) is a virtual placeholder showing where the next prompt
    // will land — rewinding to it is a no-op (disk unchanged,
    // conversation unchanged). Pressing Enter on it used to open the
    // chooser with "((empty message))" and two useless restore options.
    // Treat it as a no-op: stay in the picker, do nothing. User can
    // navigate elsewhere or press Esc to exit.
    if (message.uuid === currentUUID) {
      return
    }
    const isSynthetic = !messages.includes(message)

    if (isSynthetic) {
      // Synthetic anchor (pre-rewind safety snapshot or similar). No
      // corresponding conversation message → can only restore code.
      // The chooser will hide "both"/"conversation" via the isSynthetic
      // flag in getRestoreOptions.
      if (!isFileHistoryEnabled) {
        // Defensive — synthetic anchors only exist when file history
        // is enabled, but bail safely if state diverges.
        onClose()
        return
      }
      const anchor = anchorByMsgId.get(message.uuid)
      const diffStats = anchor
        ? await fileHistoryGetDiffVsDisk(anchor.gitHash)
        : undefined
      setMessageToRestore(message)
      setDiffStatsForRestore(diffStats)
      return
    }

    if (!isFileHistoryEnabled) {
      await restoreConversationDirectly(message)
      return
    }

    const anchor = anchorByMsgId.get(message.uuid)
    const diffStats = anchor
      ? await fileHistoryGetDiffVsDisk(anchor.gitHash)
      : undefined
    setMessageToRestore(message)
    setDiffStatsForRestore(diffStats)
  }

  async function onSelectRestoreOption(option: RestoreOption) {
    if (!messageToRestore) {
      setError('Message not found.')
      return
    }
    if (option === 'nevermind') {
      if (preselectedMessage) onClose()
      else setMessageToRestore(undefined)
      return
    }

    if (isSummarizeOption(option)) {
      onPreRestore()
      setIsRestoring(true)
      setRestoringOption(option)
      setError(undefined)
      try {
        const direction = option === 'summarize_up_to' ? 'up_to' : 'from'
        const feedback =
          (direction === 'up_to'
            ? summarizeUpToFeedback
            : summarizeFromFeedback
          ).trim() || undefined
        await onSummarize(messageToRestore, feedback, direction)
        setIsRestoring(false)
        setRestoringOption(null)
        setMessageToRestore(undefined)
        onClose()
      } catch (error) {
        logError(error as Error)
        setIsRestoring(false)
        setRestoringOption(null)
        setMessageToRestore(undefined)
        setError(`Failed to summarize:\n${error}`)
      }
      return
    }

    onPreRestore()
    setIsRestoring(true)
    setError(undefined)

    let codeError: Error | null = null
    let conversationError: Error | null = null

    // 'both' branch removed alongside the chooser option (#215). Each
    // axis is dispatched independently — file via onRestoreCode, conv
    // via onRestoreMessage. The mode args still carry 'file-only' /
    // 'conversation-only' literals for callees that historically
    // distinguished sequencing in the 'both' case; with 'both' gone
    // these are now the only modes the picker emits.
    if (option === 'file') {
      try {
        await onRestoreCode(messageToRestore, 'file-only')
      } catch (error) {
        codeError = error as Error
        logError(codeError)
      }
    }

    if (option === 'conversation') {
      try {
        await onRestoreMessage(messageToRestore, 'conversation-only')
      } catch (error) {
        conversationError = error as Error
        logError(conversationError)
      }
    }

    setIsRestoring(false)
    setMessageToRestore(undefined)

    // Handle errors
    if (conversationError && codeError) {
      setError(
        `Failed to restore the conversation and code:\n${conversationError}\n${codeError}`,
      )
    } else if (conversationError) {
      setError(`Failed to restore the conversation:\n${conversationError}`)
    } else if (codeError) {
      setError(`Failed to restore the code:\n${codeError}`)
    } else {
      // Success - close the selector
      onClose()
    }
  }

  const exitState = useExitOnCtrlCDWithKeybindings()

  const handleEscape = useCallback(() => {
    if (messageToRestore && !preselectedMessage) {
      // Go back to message list instead of closing entirely
      setMessageToRestore(undefined)
      return
    }
    onClose()
  }, [onClose, messageToRestore, preselectedMessage])

  const moveUp = useCallback(
    () => setSelectedIndex(prev => Math.max(0, prev - 1)),
    [],
  )
  const moveDown = useCallback(
    () =>
      setSelectedIndex(prev => Math.min(messageOptions.length - 1, prev + 1)),
    [messageOptions.length],
  )
  const jumpToTop = useCallback(() => setSelectedIndex(0), [])
  const jumpToBottom = useCallback(
    () => setSelectedIndex(messageOptions.length - 1),
    [messageOptions.length],
  )
  const handleSelectCurrent = useCallback(() => {
    const selected = messageOptions[selectedIndex]
    if (selected) {
      void handleSelect(selected)
    }
  }, [messageOptions, selectedIndex, handleSelect])

  // Tab: toggle between "code-restore anchors only" (default) and
  // "all turns" views. Keep focus on the same UUID across the
  // transition (see pendingFocusUuid effect).
  const toggleActiveTab = useCallback(() => {
    const currentUuid = messageOptions[selectedIndex]?.uuid ?? null
    setPendingFocusUuid(currentUuid)
    setActiveTab(prev => (prev === 'code' ? 'conversation' : 'code'))
    // Reset selectedRestoreOption to a value that exists in the
    // target tab's option set so the chooser doesn't flash a missing
    // selection on first open after toggle.
    setSelectedRestoreOption(prev =>
      prev === 'file' ? 'conversation' : 'file',
    )
  }, [messageOptions, selectedIndex])

  // Escape to close - uses Confirmation context where escape is bound
  useKeybinding('confirm:no', handleEscape, {
    context: 'Confirmation',
    isActive: !messageToRestore,
  })

  // Message selector navigation keybindings
  useKeybindings(
    {
      'messageSelector:up': moveUp,
      'messageSelector:down': moveDown,
      'messageSelector:top': jumpToTop,
      'messageSelector:bottom': jumpToBottom,
      'messageSelector:select': handleSelectCurrent,
    },
    {
      context: 'MessageSelector',
      isActive:
        !isRestoring && !error && !messageToRestore && hasMessagesToSelect,
    },
  )

  // Tab tab-switch is independent of hasMessagesToSelect — it's a
  // navigation key between two views, not an action on a row. When
  // the code tab is empty (post-/checkpoints clear, fresh project)
  // the user still needs to be able to Tab over to the conversation
  // tab to do conversation-only rewind. Earlier the toggle lived in
  // the same useKeybindings block as up/down/select, so an empty
  // visible row set disabled Tab too. Reuse the same MessageSelector
  // context name (registering a new one would silently disable the
  // binding) but key it on its own activation predicate.
  useKeybindings(
    {
      'messageSelector:toggleAllTurns': toggleActiveTab,
    },
    {
      context: 'MessageSelector',
      isActive: !isRestoring && !error && !messageToRestore,
    },
  )

  // Keyed by message UUID, not by option-list index. Tab toggles change
  // the index of the same UUID (and the (current) row in particular ends
  // up at a different index between views), so an index-keyed cache leaks
  // stale entries after toggling. The `in` check distinguishes
  //   missing key      → still loading
  //   key, value=undef → tried, no snapshot (renders the ⚠)
  //   key, DiffStats   → renders the diff
  const [fileHistoryMetadata, setFileHistoryMetadata] = useState<
    Record<string, DiffStats | undefined>
  >({})

  useEffect(() => {
    if (!isFileHistoryEnabled) return
    if (!anchorsLoaded) return // wait until listCodeAnchors resolves
    let cancelled = false
    setBulkLoaded(false) // reset on anchor changes (post-rewind, etc.)
    // Picker rows answer "what did THIS event do?" — anchor[i].tree vs
    // anchor[i+1].tree, with the newest anchor falling back to disk.
    // bulkDiffEventStats encodes this rule in one place; both picker
    // rows and /checkpoints list rows share it. Stable across disk
    // drift — once an event is recorded, its row's stats never change.
    //
    // Note: chooser uses anchor-vs-disk (a different question:
    // "if I restore this, how does disk change"). Picker and chooser
    // INTENTIONALLY differ here — historical view vs decision view.
    void bulkDiffEventStats(anchors).then(byHash => {
      if (cancelled) return
      const next: Record<string, DiffStats | undefined> = {}
      for (const userMessage of messageOptions) {
        if (userMessage.uuid === currentUUID) continue
        const anchor = anchorByMsgId.get(userMessage.uuid)
        next[userMessage.uuid] = anchor ? byHash.get(anchor.gitHash) : undefined
      }
      setFileHistoryMetadata(next)
      setBulkLoaded(true)
      logForDebugging(
        `MessageSelector: [Meta] write keys=${Object.keys(next).map(k => k.slice(0, 8)).join(',')} ` +
          `values=${Object.entries(next).map(([k, v]) => `${k.slice(0, 8)}:${v ? `ins=${v.insertions}/del=${v.deletions}/files=${v.filesChanged?.length ?? 'undef'}` : 'undef'}`).join(' ')}`,
      )
    })
    return () => {
      cancelled = true
    }
  }, [messageOptions, currentUUID, anchorByMsgId, isFileHistoryEnabled, anchorsLoaded])

  const canRestoreCode =
    isFileHistoryEnabled &&
    diffStatsForRestore?.filesChanged &&
    diffStatsForRestore.filesChanged.length > 0
  const showPickList =
    !error && !messageToRestore && !preselectedMessage && hasMessagesToSelect

  return (
    <Box flexDirection="column" width="100%">
      <Divider color="suggestion" />
      <Box flexDirection="column" marginX={1} gap={1}>
        <Text bold color="suggestion">
          Rewind
        </Text>

        {error && (
          <>
            <Text color="error">Error: {error}</Text>
          </>
        )}
        {!hasMessagesToSelect && (
          <>
            {activeTab === 'code' && hasAnySnapshot ? (
              <Text>Nothing to rewind to yet.</Text>
            ) : activeTab === 'code' ? (
              // Code tab + no anchors at all = post-clear or fresh
              // project. Direct the user to the conversation tab if
              // they need conversation-only rewind.
              <Text>
                No file checkpoints in this session. Press Tab for
                conversation rewind.
              </Text>
            ) : (
              <Text>Nothing to rewind to yet.</Text>
            )}
          </>
        )}
        {!error && messageToRestore && hasMessagesToSelect && (
          <>
            <Text>
              Confirm you want to restore{' '}
              {!diffStatsForRestore && 'the conversation '}to the point before
              you sent this message:
            </Text>
            <Box
              flexDirection="column"
              paddingLeft={1}
              borderStyle="single"
              borderRight={false}
              borderTop={false}
              borderBottom={false}
              borderLeft={true}
              borderLeftDimColor
            >
              <UserMessageOption
                userMessage={messageToRestore}
                color="text"
                isCurrent={false}
              />
              <Text dimColor>
                ({formatRelativeTimeAgo(new Date(messageToRestore.timestamp))})
              </Text>
            </Box>
            <RestoreOptionDescription
              selectedRestoreOption={selectedRestoreOption}
              canRestoreCode={!!canRestoreCode}
              diffStatsForRestore={diffStatsForRestore}
            />
            {isRestoring && isSummarizeOption(restoringOption) ? (
              <Box flexDirection="row" gap={1}>
                <Spinner />
                <Text>Summarizing…</Text>
              </Box>
            ) : (
              <Select
                isDisabled={isRestoring}
                options={getRestoreOptions(
                  !!canRestoreCode,
                  !messages.includes(messageToRestore),
                )}
                defaultFocusValue={
                  !messages.includes(messageToRestore)
                    ? 'code'
                    : canRestoreCode
                      ? 'both'
                      : 'conversation'
                }
                onFocus={value =>
                  setSelectedRestoreOption(value as RestoreOption)
                }
                onChange={value =>
                  onSelectRestoreOption(value as RestoreOption)
                }
                onCancel={() =>
                  preselectedMessage
                    ? onClose()
                    : setMessageToRestore(undefined)
                }
              />
            )}
            {canRestoreCode && (
              <Box marginBottom={1}>
                <Text dimColor>
                  {figures.warning} Rewinding does not affect files edited
                  manually or via bash.
                </Text>
              </Box>
            )}
          </>
        )}
        {showPickList && (
          <>
            {isFileHistoryEnabled ? (
              <Text>
                {activeTab === 'code'
                  ? 'Restore the file to the point before…'
                  : 'Restore the conversation to the point before…'}
              </Text>
            ) : (
              <Text>
                Restore and fork the conversation to the point before…
              </Text>
            )}
            {activeTab === 'conversation' && isFileHistoryEnabled && (
              // Conversation rewind is in-memory only — the JSONL chain
              // head doesn't move with restoreMessageSync. On /resume
              // the picker will reflect the pre-rewind state. Tracked
              // in [[project-conversation-rewind-persistence]].
              <Text dimColor italic>
                {figures.warning} Conversation rewind is current-session only — restart restores the original chain.
              </Text>
            )}
            <Box width="100%" flexDirection="column">
              {messageOptions
                .slice(
                  firstVisibleIndex,
                  firstVisibleIndex + MAX_VISIBLE_MESSAGES,
                )
                .map((msg, visibleOptionIndex) => {
                  const optionIndex = firstVisibleIndex + visibleOptionIndex
                  const isSelected = optionIndex === selectedIndex
                  const isCurrent = msg.uuid === currentUUID
                  // Synthetic anchor rows (orphan turns + pre-rewind
                  // safety nets) bake the "↶ Before / Undo rewind to
                  // before" prefix into their message content in
                  // syntheticAnchors above. Detect them by uuid — any
                  // anchor's messageId that isn't in the active
                  // conversation chain is a synthetic.
                  const isSyntheticAnchorRow =
                    !isCurrent && !conversationUuids.has(msg.uuid)

                  // metadataLoaded is true once the bulk-diff effect
                  // has written this row's key; loading state below
                  // forces a placeholder until anchors+bulk both arrive.
                  const metadataLoaded =
                    !isCurrent &&
                    (!anchorsLoaded ||
                      !bulkLoaded ||
                      msg.uuid in fileHistoryMetadata)
                  const metadata = fileHistoryMetadata[msg.uuid]
                  const numFilesChanged =
                    metadata?.filesChanged && metadata.filesChanged.length

                  return (
                    <Box
                      key={msg.uuid}
                      // Code tab needs a stats sub-line per row (anchor
                      // diff badge / "No code changes" / loading
                      // placeholder), so reserve 3 rows. Conversation
                      // tab renders only the label — height=2 keeps
                      // rows packed visually instead of leaving the
                      // stats slot as dead whitespace.
                      height={
                        isFileHistoryEnabled && activeTab === 'code' ? 3 : 2
                      }
                      overflow="hidden"
                      width="100%"
                      flexDirection="row"
                    >
                      <Box width={2} minWidth={2}>
                        {isSelected ? (
                          <Text color="permission" bold>
                            {figures.pointer}{' '}
                          </Text>
                        ) : (
                          <Text>{'  '}</Text>
                        )}
                      </Box>
                      <Box flexDirection="column">
                        <Box flexShrink={1} height={1} overflow="hidden" flexDirection="row">
                          {!isCurrent && !isSyntheticAnchorRow && (
                            // Hermes-aligned label semantics: every
                            // anchor is a pre-tool snapshot, so the
                            // row reads "Before <prompt>" — selecting
                            // it restores file state to BEFORE that
                            // turn ran. Synthetic ↶ rows already bake
                            // 'Before' into their content string in
                            // the syntheticAnchors useMemo, so we
                            // don't double it up there.
                            <Text
                              color={isSelected ? 'suggestion' : undefined}
                              dimColor={!isSelected}
                            >
                              Before{' '}
                            </Text>
                          )}
                          <UserMessageOption
                            userMessage={msg}
                            color={isSelected ? 'suggestion' : undefined}
                            isCurrent={isCurrent}
                            paddingRight={10}
                          />
                        </Box>
                        {isFileHistoryEnabled &&
                          metadataLoaded &&
                          activeTab === 'code' && (
                          <Box height={1} flexDirection="row">
                            {!anchorsLoaded || !bulkLoaded ? (
                              // Picker just mounted (or anchors changed
                              // post-rewind): listCodeAnchors and/or
                              // bulkDiffVsDisk still in flight (~80-150ms
                              // on Windows). Render a neutral
                              // placeholder rather than ⚠, which carries
                              // a "no code restore" semantic that
                              // doesn't apply yet — we don't know.
                              <Text dimColor color="inactive">
                                …
                              </Text>
                            ) : metadata && numFilesChanged ? (
                              <Text dimColor={!isSelected} color="inactive">
                                {numFilesChanged === 1 &&
                                metadata.filesChanged![0]
                                  ? `${path.basename(metadata.filesChanged![0])} `
                                  : `${numFilesChanged} files changed `}
                                <DiffStatsText diffStats={metadata} />
                              </Text>
                            ) : metadata ? (
                              // Anchor exists, but its tree matches the
                              // current disk — "Restore code" here is a
                              // no-op, not a missing-anchor situation.
                              // Common on ↶ rows whose protected state
                              // happens to equal "now" (e.g. user just
                              // un-did the rewind that produced them).
                              // Flat label, no warning glyph: the row
                              // is selectable and harmless, just
                              // redundant.
                              <Text dimColor color="inactive">
                                No code changes
                              </Text>
                            ) : (
                              // No anchor at all (readonly turn that
                              // never produced a snapshot). Flag with
                              // ⚠ — Restore code can't run because
                              // there's nothing to restore from.
                              <Text dimColor color="warning">
                                {figures.warning} No code restore
                              </Text>
                            )}
                          </Box>
                        )}
                      </Box>
                    </Box>
                  )
                })}
            </Box>
          </>
        )}
        {!messageToRestore && (
          <Text dimColor italic>
            {exitState.pending ? (
              <>Press {exitState.keyName} again to exit</>
            ) : (
              <>
                {!error && hasMessagesToSelect && 'Enter to continue · '}
                {(() => {
                  // Footer Tab-prompt now reflects mode-tab semantics:
                  // tells the user what tab they'd switch to, not how
                  // many rows would change. Mode is the load-bearing
                  // concept; row count is incidental.
                  // Internal tab type is still 'code' for backward
                  // compatibility; the user-visible label is "file"
                  // since the anchors track file changes (not "code"
                  // semantics like AST or syntax). Vocabulary chosen
                  // to match the underlying behavior.
                  const target = activeTab === 'code' ? 'conversation' : 'file'
                  return (
                    <>
                      Tab to switch to {target} rewind
                      {' · '}
                    </>
                  )
                })()}
                {syntheticAnchors.length > 0 && (
                  <>
                    {`↶ rows are off-branch anchors — pick to restore code from that point`}
                    {' · '}
                  </>
                )}
                Esc to exit
              </>
            )}
          </Text>
        )}
      </Box>
    </Box>
  )
}

function getRestoreOptionConversationText(option: RestoreOption): string {
  switch (option) {
    case 'summarize':
      return 'Messages after this point will be summarized.'
    case 'summarize_up_to':
      return 'Preceding messages will be summarized. This and subsequent messages will remain unchanged — you will stay at the end of the conversation.'
    case 'conversation':
      return 'The conversation will be forked.'
    case 'file':
    case 'nevermind':
      return 'The conversation will be unchanged.'
  }
}

function RestoreOptionDescription({
  selectedRestoreOption,
  canRestoreCode,
  diffStatsForRestore,
}: {
  selectedRestoreOption: RestoreOption
  canRestoreCode: boolean
  diffStatsForRestore: DiffStats | undefined
}): React.ReactNode {
  const showCodeRestore =
    canRestoreCode && selectedRestoreOption === 'file'

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {getRestoreOptionConversationText(selectedRestoreOption)}
      </Text>
      {!isSummarizeOption(selectedRestoreOption) &&
        (showCodeRestore ? (
          <RestoreCodeConfirmation diffStatsForRestore={diffStatsForRestore} />
        ) : (
          <Text dimColor>The file will be unchanged.</Text>
        ))}
    </Box>
  )
}

function RestoreCodeConfirmation({
  diffStatsForRestore,
}: {
  diffStatsForRestore: DiffStats | undefined
}): React.ReactNode {
  if (diffStatsForRestore === undefined) {
    return undefined
  }
  if (
    !diffStatsForRestore.filesChanged ||
    !diffStatsForRestore.filesChanged[0]
  ) {
    return (
      <Text dimColor>The code has not changed (nothing will be restored).</Text>
    )
  }

  const numFilesChanged = diffStatsForRestore.filesChanged.length

  let fileLabel = ''
  if (numFilesChanged === 1) {
    fileLabel = path.basename(diffStatsForRestore.filesChanged[0] || '')
  } else if (numFilesChanged === 2) {
    const file1 = path.basename(diffStatsForRestore.filesChanged[0] || '')
    const file2 = path.basename(diffStatsForRestore.filesChanged[1] || '')
    fileLabel = `${file1} and ${file2}`
  } else {
    const file1 = path.basename(diffStatsForRestore.filesChanged[0] || '')
    fileLabel = `${file1} and ${diffStatsForRestore.filesChanged.length - 1} other files`
  }

  return (
    <>
      <Text dimColor>
        The code will be restored{' '}
        <DiffStatsText diffStats={diffStatsForRestore} /> in {fileLabel}.
      </Text>
    </>
  )
}

function DiffStatsText({
  diffStats,
}: {
  diffStats: DiffStats | undefined
}): React.ReactNode {
  if (!diffStats || !diffStats.filesChanged) {
    return undefined
  }
  return (
    <>
      <Text color="diffAddedWord">+{diffStats.insertions} </Text>
      <Text color="diffRemovedWord">-{diffStats.deletions}</Text>
    </>
  )
}

function UserMessageOption({
  userMessage,
  color,
  dimColor,
  isCurrent,
  paddingRight,
}: {
  userMessage: UserMessage
  color?: keyof Theme
  dimColor?: boolean
  isCurrent: boolean
  paddingRight?: number
}): React.ReactNode {
  const { columns } = useTerminalSize()
  if (isCurrent) {
    return (
      <Box width="100%">
        <Text italic color={color} dimColor={dimColor}>
          (current)
        </Text>
      </Box>
    )
  }

  const content = userMessage.message.content
  const lastBlock =
    typeof content === 'string' ? null : content[content.length - 1]
  const rawMessageText =
    typeof content === 'string'
      ? content.trim()
      : lastBlock && isTextBlock(lastBlock)
        ? lastBlock.text.trim()
        : '(no prompt)'

  // Strip display-unfriendly tags (like <ide_opened_file>) before showing in the list
  const messageText = stripDisplayTags(rawMessageText)

  if (isEmptyMessageText(messageText)) {
    return (
      <Box flexDirection="row" width="100%">
        <Text italic color={color} dimColor={dimColor}>
          ((empty message))
        </Text>
      </Box>
    )
  }

  // Bash inputs
  if (messageText.includes('<bash-input>')) {
    const input = extractTag(messageText, 'bash-input')
    if (input) {
      return (
        <Box flexDirection="row" width="100%">
          <Text color="bashBorder">!</Text>
          <Text color={color} dimColor={dimColor}>
            {' '}
            {input}
          </Text>
        </Box>
      )
    }
  }

  // Skills and slash commands
  if (messageText.includes(`<${COMMAND_MESSAGE_TAG}>`)) {
    const commandMessage = extractTag(messageText, COMMAND_MESSAGE_TAG)
    const args = extractTag(messageText, 'command-args')
    const isSkillFormat = extractTag(messageText, 'skill-format') === 'true'
    if (commandMessage) {
      if (isSkillFormat) {
        // Skills: Display as "Skill(name)"
        return (
          <Box flexDirection="row" width="100%">
            <Text color={color} dimColor={dimColor}>
              Skill({commandMessage})
            </Text>
          </Box>
        )
      } else {
        // Slash commands: Add "/" prefix and include args
        return (
          <Box flexDirection="row" width="100%">
            <Text color={color} dimColor={dimColor}>
              /{commandMessage} {args}
            </Text>
          </Box>
        )
      }
    }
  }

  // User prompts
  return (
    <Box flexDirection="row" width="100%">
      <Text color={color} dimColor={dimColor}>
        {paddingRight
          ? truncate(messageText, columns - paddingRight, true)
          : messageText.slice(0, 500).split('\n').slice(0, 4).join('\n')}
      </Text>
    </Box>
  )
}

/**
 * The user-visible text of a message, mirroring how the picker decides
 * what label to show. Returns '' for non-text messages.
 *
 * Used by `selectableUserMessagesFilter` to detect tag-marked outputs
 * (command stdout/stderr, bash output, tick markers, task notifications)
 * that look like user messages but are actually injected metadata.
 */
export function getMessageText(message: Message): string {
  if (message.type !== 'user') return ''
  const content = message.message.content
  if (typeof content === 'string') return content.trim()
  const lastBlock = content[content.length - 1]
  return lastBlock && isTextBlock(lastBlock) ? lastBlock.text.trim() : ''
}

export function selectableUserMessagesFilter(
  message: Message,
): message is UserMessage {
  if (message.type !== 'user') {
    return false
  }
  if (
    Array.isArray(message.message.content) &&
    message.message.content[0]?.type === 'tool_result'
  ) {
    return false
  }
  if (isSyntheticMessage(message)) {
    return false
  }
  if (message.isMeta) {
    return false
  }
  if (message.isCompactSummary || message.isVisibleInTranscriptOnly) {
    return false
  }

  const messageText = getMessageText(message)

  // Filter out non-user-authored messages (command outputs, task notifications, ticks).
  // Slash commands (`/checkpoints`, `/help`, ...) come in two shapes:
  //   - the input itself, wrapped in <command-name>/<command-message>
  //   - the rendered output, wrapped in <local-command-stdout/stderr>
  // Both must be excluded for symmetry. Including only the output (as
  // earlier code did) leaves /command rows in the all-turns picker
  // view but their stdout invisible — confusing and asymmetric.
  if (
    messageText.indexOf(`<${LOCAL_COMMAND_STDOUT_TAG}>`) !== -1 ||
    messageText.indexOf(`<${LOCAL_COMMAND_STDERR_TAG}>`) !== -1 ||
    messageText.indexOf(`<${COMMAND_MESSAGE_TAG}>`) !== -1 ||
    messageText.indexOf(`<${COMMAND_NAME_TAG}>`) !== -1 ||
    messageText.indexOf(`<${BASH_STDOUT_TAG}>`) !== -1 ||
    messageText.indexOf(`<${BASH_STDERR_TAG}>`) !== -1 ||
    messageText.indexOf(`<${TASK_NOTIFICATION_TAG}>`) !== -1 ||
    messageText.indexOf(`<${TICK_TAG}>`) !== -1 ||
    messageText.indexOf(`<${TEAMMATE_MESSAGE_TAG}`) !== -1
  ) {
    return false
  }
  return true
}

/**
 * Checks if all messages after the given index are synthetic (interruptions, cancels, etc.)
 * or non-meaningful content. Returns true if there's nothing meaningful to confirm -
 * for example, if the user hit enter then immediately cancelled.
 */
export function messagesAfterAreOnlySynthetic(
  messages: Message[],
  fromIndex: number,
): boolean {
  for (let i = fromIndex + 1; i < messages.length; i++) {
    const msg = messages[i]
    if (!msg) continue

    // Skip known non-meaningful message types
    if (isSyntheticMessage(msg)) continue
    if (isToolUseResultMessage(msg)) continue
    if (msg.type === 'progress') continue
    if (msg.type === 'system') continue
    if (msg.type === 'attachment') continue
    if (msg.type === 'user' && msg.isMeta) continue

    // Assistant with actual content = meaningful
    if (msg.type === 'assistant') {
      const content = msg.message.content
      if (Array.isArray(content)) {
        const hasMeaningfulContent = content.some(
          block =>
            (block.type === 'text' && block.text.trim()) ||
            block.type === 'tool_use',
        )
        if (hasMeaningfulContent) return false
      }
      continue
    }

    // User messages that aren't synthetic or meta = meaningful
    if (msg.type === 'user') {
      return false
    }

    // Other types (e.g., tombstone) are non-meaningful, continue
  }
  return true
}
