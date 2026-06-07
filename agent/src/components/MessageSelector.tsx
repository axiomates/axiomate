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
  type CheckpointHashLabel,
  type DiffStats,
  type RewindCodeRow,
  buildRewindCodeRows,
  fileHistoryEnabled,
  fileHistoryGetDiffVsDisk,
} from '../utils/fileHistory.js'
import {
  type CodeAnchor,
  listCodeAnchors,
} from '../utils/checkpoints/listCodeAnchors.js'
import {
  decrementPickerOpenCount,
  getOriginalCwd,
  getSessionId,
  incrementPickerOpenCount,
} from '../bootstrap/state.js'
import {
  findChainUserMessages,
} from '../utils/conversationBranches.js'
import {
  getTranscriptPathForSession,
  loadTranscriptFile,
  pickConversationHead,
} from '../utils/sessionStorage.js'
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
import type { TranscriptMessage } from '../types/logs.js'
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
import { formatAgeOrAbsolute } from '../commands/checkpoints/format.js'
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

function restoringStatusText(option: RestoreOption | null): string {
  switch (option) {
    case 'file':
      return 'Restoring files… This may take a moment.'
    case 'conversation':
      return 'Restoring conversation…'
    case 'summarize':
    case 'summarize_up_to':
      return 'Summarizing…'
    default:
      return 'Restoring…'
  }
}

type Props = {
  messages: Message[]
  onPreRestore: () => void
  onRestoreMessage: (
    message: UserMessage,
    mode?: 'conversation-only',
    /** When provided, REPL prefills the input box with this prompt
     *  instead of the rewind target's own prompt. Set by the
     *  conversation-tab path so selecting X (a past Q/A turn)
     *  prefills the *next* turn — the one the user is about to
     *  redo. Optional so file-tab and other call sites stay
     *  unchanged (they fall back to the legacy "prefill target"
     *  semantic). */
    nextUserPrompt?: UserMessage | null,
  ) => Promise<void>
  onRestoreCode: (
    message: UserMessage,
    mode?: 'file-only',
    restoreHash?: string,
  ) => Promise<void>
  onSummarize: (
    message: UserMessage,
    feedback?: string,
    direction?: PartialCompactDirection,
  ) => Promise<void>
  onClose: () => void
  fileHistoryLabelsByHash?: ReadonlyMap<string, CheckpointHashLabel>
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
  fileHistoryLabelsByHash = new Map(),
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
  const [codeRows, setCodeRows] = useState<readonly RewindCodeRow[]>([])
  const [codeRowsLoaded, setCodeRowsLoaded] = useState(false)
  const [anchorsLoaded, setAnchorsLoaded] = useState(false)
  // Tracks whether row metadata has been projected into the picker.
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

  // Abandoned-branch loader (conversation-axis only). Reads the JSONL
  // transcript on mount and computes the leaves not on the active
  // chain — these are the rewound-away branches the picker exposes via
  // the conversation tab so users can switch to / inspect them.
  // Conversation-tab chain loader: read the JSONL transcript on mount
  // and compute the full set of user prompts on the current chain
  // (newest leaf walking back via parentUuid). Lets the picker show
  // every prompt the user can rewind to — including "future" prompts
  // that disappeared from the in-memory `messages` array after a
  // rewind. Loader fires regardless of activeTab so toggling Tab is
  // instant; rendering is gated on activeTab.
  //
  // chainUserMessages is the picker's row source for the conversation
  // tab. headLeafUuid is the message id whose row gets the
  // (current) tag — the head pointer's resolved target.
  const [chainUserMessages, setChainUserMessages] = useState<readonly UserMessage[]>([])
  const [headLeafUuid, setHeadLeafUuid] = useState<UUID | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const sessionFile = getTranscriptPathForSession(getSessionId())
        const loaded = await loadTranscriptFile(sessionFile)
        if (cancelled) return
        // Walk the full chain from the latest leaf, NOT from
        // conversationHead. Why: after a rewind, the head record points
        // at the user's chosen earlier turn (e.g. A) — walking from
        // there only yields [A], hiding "future" turns (B, C) that are
        // physically still in the JSONL (it's append-only) but
        // post-head on the chain.
        //
        // The user-facing model is "show every prompt on this single
        // chain, including the ones I rewound past so I can re-select
        // them". The latest leaf is the chain tip — walking parentUuid
        // from it yields the full set. The head record is then ONLY
        // used to decide which row gets the (current) tag.
        const latestLeafMsg = pickConversationHead({
          messages: loaded.messages,
          leafUuids: loaded.leafUuids,
          // Force the latest-leaf path, ignoring any head record.
          conversationHead: undefined,
          leafPredicate: msg => msg.type === 'user' || msg.type === 'assistant',
        })
        const chain = findChainUserMessages({
          messages: loaded.messages,
          headLeafUuid: latestLeafMsg?.uuid,
        })
        // Resolve where the (current) tag lands.
        //
        //   1. Head record exists: walk parentUuid back from the head
        //      target until we hit a user message on the chain — that
        //      row gets the tag. Head points at the chain tail (last
        //      assistant frame of the kept turn) so the walk normally
        //      lands on the user msg one or two parents up.
        //   2. No head record: never been rewound, head is at the
        //      chain tip (latest leaf).
        let headForUi: UUID | undefined
        if (loaded.conversationHead) {
          const target = loaded.messages.get(loaded.conversationHead.headUuid)
          if (target) {
            const chainUuids = new Set(chain.map(m => m.uuid))
            let cur: TranscriptMessage | undefined = target
            const seen = new Set<UUID>()
            while (cur && !seen.has(cur.uuid)) {
              seen.add(cur.uuid)
              if (cur.type === 'user' && chainUuids.has(cur.uuid)) {
                headForUi = cur.uuid
                break
              }
              if (!cur.parentUuid) break
              cur = loaded.messages.get(cur.parentUuid)
            }
          }
        }
        if (!headForUi && chain.length > 0) {
          headForUi = chain[chain.length - 1]!.uuid
        }
        setChainUserMessages(chain)
        setHeadLeafUuid(headForUi)
        logForDebugging(
          `MessageSelector: [Chain] loaded ${chain.length} user message(s) ` +
            `latestLeaf=${latestLeafMsg?.uuid.slice(0, 8) ?? 'none'} ` +
            `headRecord=${loaded.conversationHead?.headUuid.slice(0, 8) ?? 'none'} ` +
            `headForUi=${headForUi?.slice(0, 8) ?? 'none'}`,
        )
      } catch (e) {
        if (!cancelled) logError(e as Error)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!isFileHistoryEnabled) return
    if (!anchorsLoaded) return
    let cancelled = false
    setCodeRowsLoaded(false)
    setBulkLoaded(false)
    void buildRewindCodeRows(anchors, fileHistoryLabelsByHash).then(rows => {
      if (cancelled) return
      setCodeRows(rows)
      setCodeRowsLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [anchors, anchorsLoaded, fileHistoryLabelsByHash, isFileHistoryEnabled])

  const anchorByMsgId = useMemo(() => {
    const m = new Map<UUID, CodeAnchor>()
    for (const a of anchors) {
      if (a.messageId) m.set(a.messageId, a)
    }
    return m
  }, [anchors])

  const codeRowByRowId = useMemo(() => {
    const m = new Map<string, RewindCodeRow>()
    for (const row of codeRows) m.set(row.rowId, row)
    return m
  }, [codeRows])
  const codeRowByMsgId = useMemo(() => {
    const m = new Map<UUID, RewindCodeRow>()
    for (const row of codeRows) {
      if (row.labelMessageId) m.set(row.labelMessageId, row)
    }
    return m
  }, [codeRows])
  const codeRowForUuid = useCallback(
    (uuid: UUID) => codeRowByRowId.get(uuid) ?? codeRowByMsgId.get(uuid),
    [codeRowByRowId, codeRowByMsgId],
  )

  const fileRowMessages = useMemo<UserMessage[]>(() => {
    return codeRows.map(row => ({
      ...createUserMessage({ content: row.labelText }),
      uuid: row.rowId as UUID,
    }) as UserMessage)
  }, [codeRows])

  const hasAnySnapshot = isFileHistoryEnabled && anchors.length > 0
  // File tab uses hash-keyed rows from buildRewindCodeRows. Conversation
  // tab uses every user prompt on the current chain, including post-rewind
  // "future" prompts still present in JSONL.
  const visibleSelectable = useMemo(
    () => {
      if (activeTab === 'conversation') {
        return chainUserMessages.length > 0 ? chainUserMessages : allSelectable
      }
      if (!hasAnySnapshot) return [] // Code tab + no anchors = empty
      return fileRowMessages
    },
    [allSelectable, activeTab, hasAnySnapshot, chainUserMessages, fileRowMessages],
  )
  useEffect(() => {
    if (!isFileHistoryEnabled) return
    const anchorMatches = allSelectable.filter(m => anchorByMsgId.has(m.uuid))
    logForDebugging(
      `MessageSelector: [Picker] state messages=${messages.length} ` +
        `allSelectable=${allSelectable.length} anchors=${anchors.length} ` +
        `anchors-in-conversation=${anchorMatches.length} fileRows=${codeRows.length}`,
    )
  }, [
    isFileHistoryEnabled,
    messages,
    allSelectable,
    anchors,
    anchorByMsgId,
    codeRows.length,
  ])

  const messageOptions = useMemo(() => {
    if (activeTab === 'code') {
      const currentRow: UserMessage = {
        ...createUserMessage({ content: '' }),
        uuid: currentUUID,
      } as UserMessage
      return [currentRow, ...visibleSelectable]
    }

    // Conversation tab: natural reverse-chronological order (newest
    // at top, oldest at bottom — same shape as git log). The head row
    // sits at its real position; viewport anchoring (below) makes
    // sure it lands at the top of the visible area on open. ↑ scrolls
    // into "future" (post-head turns that re-appear after a rewind),
    // ↓ scrolls into "past" (pre-head turns).
    return [...visibleSelectable].reverse()
  }, [
    visibleSelectable,
    currentUUID,
    activeTab,
  ])
  // Default cursor on the newest selectable row (index 1 — index 0
  // is the (current) row, which is non-selectable). Falls back to 0
  // when there is no other row, so the picker still mounts cleanly.
  const [selectedIndex, setSelectedIndex] = useState(
    messageOptions.length > 1 ? 1 : 0,
  )

  // When the conversation tab finishes loading the chain (or the user
  // switches into it), point selection at the head row so the (current)
  // tag is on screen by default. File tab keeps baseline behavior
  // (selection at the first non-(current) row).
  useEffect(() => {
    if (activeTab !== 'conversation') return
    if (!headLeafUuid) return
    const idx = messageOptions.findIndex(m => m.uuid === headLeafUuid)
    if (idx >= 0) setSelectedIndex(idx)
  }, [activeTab, headLeafUuid, messageOptions])

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

  // Viewport anchoring rules differ by tab:
  //
  //   File tab — center the selection (baseline). Selected row sits
  //     at the middle of the visible window so users see equal
  //     context above/below.
  //
  //   Conversation tab — top-anchor on open, slide on scroll. The
  //     window starts with the head row at the top (head is the
  //     default selectedIndex), so users see "I'm here, future is
  //     up, past is down" without scrolling. As ↑/↓ moves the
  //     selection, the window slides only enough to keep selection
  //     visible — selection stays near the top edge instead of
  //     bouncing to center.
  const [firstVisibleIndex, setFirstVisibleIndex] = useState(0)
  useEffect(() => {
    if (activeTab !== 'conversation') return
    setFirstVisibleIndex(prev => {
      const maxFirst = Math.max(0, messageOptions.length - MAX_VISIBLE_MESSAGES)
      // If selection moved above the window, slide window up to it.
      if (selectedIndex < prev) return Math.max(0, selectedIndex)
      // If selection moved below the window, slide window down so
      // selection sits at the bottom edge.
      if (selectedIndex >= prev + MAX_VISIBLE_MESSAGES) {
        return Math.min(maxFirst, selectedIndex - MAX_VISIBLE_MESSAGES + 1)
      }
      // Selection is inside the current window — clamp first to
      // bounds in case messageOptions just shrank.
      return Math.min(prev, maxFirst)
    })
  }, [activeTab, selectedIndex, messageOptions.length])
  // Re-anchor at head whenever the head moves (or chain reloads).
  // This is the "open with head at top" behavior on entry.
  useEffect(() => {
    if (activeTab !== 'conversation') return
    if (headLeafUuid === undefined) return
    const idx = messageOptions.findIndex(m => m.uuid === headLeafUuid)
    if (idx < 0) return
    const maxFirst = Math.max(0, messageOptions.length - MAX_VISIBLE_MESSAGES)
    setFirstVisibleIndex(Math.min(idx, maxFirst))
  }, [activeTab, headLeafUuid, messageOptions])
  // File-tab viewport: derive on every render (baseline).
  const fileFirstVisibleIndex = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(MAX_VISIBLE_MESSAGES / 2),
      messageOptions.length - MAX_VISIBLE_MESSAGES,
    ),
  )
  const effectiveFirstVisible =
    activeTab === 'conversation' ? firstVisibleIndex : fileFirstVisibleIndex

  // File tab seeds messageOptions with a virtual (current) row at index
  // 0, so "any actionable row" = length > 1. Conversation tab does NOT
  // seed that row (the head pointer is shown in-line as a (current) tag
  // instead), so a single-message chain has length === 1 — still
  // actionable. Earlier this was a flat `> 1` and a fresh "hi"-only
  // session showed "Nothing to rewind to yet" on the conversation tab.
  const hasMessagesToSelect =
    activeTab === 'conversation'
      ? messageOptions.length >= 1
      : messageOptions.length > 1

  const [messageToRestore, setMessageToRestore] = useState<
    UserMessage | undefined
  >(preselectedMessage)
  const [diffStatsForRestore, setDiffStatsForRestore] = useState<
    DiffStats | undefined
  >(undefined)
  const [restoreHashForRestore, setRestoreHashForRestore] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!preselectedMessage || !isFileHistoryEnabled) return
    let cancelled = false
    const row = codeRowForUuid(preselectedMessage.uuid)
    if (row) {
      setDiffStatsForRestore(row.diffStats)
      setRestoreHashForRestore(row.restoreHash)
      return
    }
    const anchor = anchorByMsgId.get(preselectedMessage.uuid)
    if (!anchor) {
      setDiffStatsForRestore(undefined)
      setRestoreHashForRestore(undefined)
      return
    }
    void fileHistoryGetDiffVsDisk(anchor.gitHash).then(stats => {
      if (!cancelled) {
        setDiffStatsForRestore(stats)
        setRestoreHashForRestore(anchor.gitHash)
      }
    })
    return () => {
      cancelled = true
    }
  }, [preselectedMessage, isFileHistoryEnabled, anchorByMsgId, codeRowForUuid])

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
  // Tab governs WHICH AXIS the chooser operates on:
  //   - File tab: file-axis actions only (Restore file)
  //   - Conversation tab: conversation-axis actions only (Restore
  //     conversation, Summarize)
  // The two axes are kept independent — file goes through git store
  // (persistent, undoable via ↶ rows), conversation through in-memory
  // truncation (#188 deferred). Mixing them in one chooser would
  // create asymmetric undo states.
  //
  //   - File tab + regular row + diff: Restore file
  //   - File tab + regular row + no diff: nothing actionable
  //   - File tab + ↶ row + diff: Restore file
  //   - File tab + ↶ row + no diff: nothing actionable
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
      // File tab keeps to file-axis actions only — Restore conversation
      // belongs in the Conversation tab. Mixing them here violated the
      // "file and conversation are independent axes" rule and produced
      // an asymmetric chooser: file picker rows would offer to truncate
      // the conversation chain too, but conversation tab rows can't
      // offer to restore files (no anchor association).
      //
      // 'Restore file and conversation' was already removed (#215) for
      // a related reason: it bundled a persistent file rewind with an
      // in-memory conversation truncation, leaving a half-undoable
      // state. Restricting File tab to file-only actions is the next
      // step of the same decoupling.
      //
      // If canRestoreCode is false (anchor.tree == disk), only Never
      // mind remains — picker still showed the row (every event is
      // historically real and worth listing) but chooser refuses
      // no-op actions.
      baseOptions = canRestoreCode
        ? [{ value: 'file', label: 'Restore file' }]
        : []
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

  // Resolve the next user message after `target` on the current
  // conversation chain. Used to compute the input-box prefill for
  // conversation rewind: selecting X means "I want to redo the
  // turn after X", so the input gets the next prompt.
  //
  // Returns null when X is the chain tail (nothing to redo —
  // input box is cleared on selection of head row, but that path
  // is gated as a no-op upstream so we shouldn't reach here for
  // it). Also returns null in non-conversation contexts where
  // chainUserMessages hasn't loaded.
  function nextUserAfter(target: UserMessage): UserMessage | null {
    if (chainUserMessages.length === 0) return null
    const idx = chainUserMessages.findIndex(m => m.uuid === target.uuid)
    if (idx === -1) return null
    return chainUserMessages[idx + 1] ?? null
  }

  // Helper to restore conversation without confirmation
  async function restoreConversationDirectly(message: UserMessage) {
    onPreRestore()
    setIsRestoring(true)
    try {
      await onRestoreMessage(message, 'conversation-only', nextUserAfter(message))
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
    // Conversation tab: pressing Enter on the (current) row is a
    // no-op for the same reason — rewinding to where you already
    // are changes nothing. Keeps the picker open so the user can
    // ↑↓ to a different turn or Esc out.
    if (activeTab === 'conversation' && message.uuid === headLeafUuid) {
      return
    }
    // File-tab synthetic rows = file-rewind ↶ anchor rows whose uuid
    // isn't in the in-memory `messages` array. Conversation-tab rows
    // are all real user messages (loaded from JSONL chain), so the
    // "uuid not in `messages`" predicate would mis-classify every
    // post-rewind chain row as synthetic. Gate on activeTab.
    const isSynthetic =
      activeTab === 'code' && !messages.includes(message)

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
      const row = codeRowForUuid(message.uuid)
      if (row) {
        setMessageToRestore(message)
        setDiffStatsForRestore(row.diffStats)
        setRestoreHashForRestore(row.restoreHash)
        return
      }
      const anchor = anchorByMsgId.get(message.uuid)
      const diffStats = anchor
        ? await fileHistoryGetDiffVsDisk(anchor.gitHash)
        : undefined
      setMessageToRestore(message)
      setDiffStatsForRestore(diffStats)
      setRestoreHashForRestore(anchor?.gitHash)
      return
    }

    if (!isFileHistoryEnabled) {
      await restoreConversationDirectly(message)
      return
    }

    const row = codeRowForUuid(message.uuid)
    if (row) {
      setMessageToRestore(message)
      setDiffStatsForRestore(row.diffStats)
      setRestoreHashForRestore(row.restoreHash)
      return
    }
    const anchor = anchorByMsgId.get(message.uuid)
    const diffStats = anchor
      ? await fileHistoryGetDiffVsDisk(anchor.gitHash)
      : undefined
    setMessageToRestore(message)
    setDiffStatsForRestore(diffStats)
    setRestoreHashForRestore(anchor?.gitHash)
  }

  async function onSelectRestoreOption(option: RestoreOption) {
    if (!messageToRestore) {
      setError('Message not found.')
      return
    }
    if (option === 'nevermind') {
      if (preselectedMessage) {
        onClose()
      } else {
        setMessageToRestore(undefined)
        setRestoreHashForRestore(undefined)
      }
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
        setRestoreHashForRestore(undefined)
        onClose()
      } catch (error) {
        logError(error as Error)
        setIsRestoring(false)
        setRestoringOption(null)
        setMessageToRestore(undefined)
        setRestoreHashForRestore(undefined)
        setError(`Failed to summarize:\n${error}`)
      }
      return
    }

    onPreRestore()
    setIsRestoring(true)
    setRestoringOption(option)
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
        await onRestoreCode(messageToRestore, 'file-only', restoreHashForRestore)
      } catch (error) {
        codeError = error as Error
        logError(codeError)
      }
    }

    if (option === 'conversation') {
      try {
        await onRestoreMessage(
          messageToRestore,
          'conversation-only',
          nextUserAfter(messageToRestore),
        )
      } catch (error) {
        conversationError = error as Error
        logError(conversationError)
      }
    }

    setIsRestoring(false)
    setRestoringOption(null)
    setMessageToRestore(undefined)
    setRestoreHashForRestore(undefined)

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
    if (isRestoring) return
    if (messageToRestore && !preselectedMessage) {
      // Go back to message list instead of closing entirely
      setMessageToRestore(undefined)
        setRestoreHashForRestore(undefined)
      return
    }
    onClose()
  }, [onClose, messageToRestore, preselectedMessage, isRestoring])

  const moveUp = useCallback(
    () => setSelectedIndex(prev => Math.max(0, prev - 1)),
    [],
  )
  const moveDown = useCallback(
    () =>
      setSelectedIndex(prev => Math.min(messageOptions.length - 1, prev + 1)),
    [messageOptions.length],
  )
  // Top of the list is the (current) row, which is non-selectable.
  // Jump to the first selectable row (index 1 when present) so g
  // lands on something the user can actually act on. Falls back to
  // 0 when there's only the (current) row left.
  const jumpToTop = useCallback(
    () => setSelectedIndex(messageOptions.length > 1 ? 1 : 0),
    [messageOptions.length],
  )
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
    if (!anchorsLoaded || !codeRowsLoaded) return
    const next: Record<string, DiffStats | undefined> = {}
    for (const userMessage of messageOptions) {
      if (userMessage.uuid === currentUUID) continue
      const row = codeRowForUuid(userMessage.uuid)
      next[userMessage.uuid] = row?.diffStats
    }
    setFileHistoryMetadata(next)
    setBulkLoaded(true)
    logForDebugging(
      `MessageSelector: [Meta] write keys=${Object.keys(next).map(k => k.slice(0, 8)).join(',')} ` +
        `values=${Object.entries(next).map(([k, v]) => `${k.slice(0, 8)}:${v ? `ins=${v.insertions}/del=${v.deletions}/files=${v.filesChanged?.length ?? 'undef'}` : 'undef'}`).join(' ')}`,
    )
  }, [
    messageOptions,
    currentUUID,
    codeRowForUuid,
    isFileHistoryEnabled,
    anchorsLoaded,
    codeRowsLoaded,
  ])

  const canRestoreCode =
    isFileHistoryEnabled &&
    diffStatsForRestore?.filesChanged &&
    diffStatsForRestore.filesChanged.length > 0
  const isCodeTabLoading =
    isFileHistoryEnabled &&
    activeTab === 'code' &&
    (!anchorsLoaded || !codeRowsLoaded || !bulkLoaded)
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
            {isCodeTabLoading ? (
              <Text>Loading file checkpoints…</Text>
            ) : activeTab === 'code' && hasAnySnapshot ? (
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
            {isRestoring ? (
              <Box flexDirection="row" gap={1}>
                <Spinner />
                <Text>{restoringStatusText(restoringOption)}</Text>
              </Box>
            ) : (
              <Select
                options={getRestoreOptions(
                  !!canRestoreCode,
                  activeTab === 'code' && !messages.includes(messageToRestore),
                )}
                defaultFocusValue={
                  activeTab === 'code'
                    ? canRestoreCode
                      ? 'file'
                      : 'nevermind'
                    : 'conversation'
                }
                onFocus={value =>
                  setSelectedRestoreOption(value as RestoreOption)
                }
                onChange={value =>
                  onSelectRestoreOption(value as RestoreOption)
                }
                onCancel={() => {
                  if (preselectedMessage) {
                    onClose()
                  } else {
                    setMessageToRestore(undefined)
                    setRestoreHashForRestore(undefined)
                  }
                }}
              />
            )}
            {canRestoreCode && (
              <Box marginBottom={1}>
                <Text dimColor>
                  {figures.warning} Rewinding does not affect files edited
                  manually.
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
            <Box width="100%" flexDirection="column">
              {messageOptions
                .slice(
                  effectiveFirstVisible,
                  effectiveFirstVisible + MAX_VISIBLE_MESSAGES,
                )
                .map((msg, visibleOptionIndex) => {
                  const optionIndex = effectiveFirstVisible + visibleOptionIndex
                  const isSelected = optionIndex === selectedIndex
                  const isCurrent = msg.uuid === currentUUID
                  // Conversation tab future-row classification:
                  // messageOptions is reverse-chrono (newest at top),
                  // so any row above the head row is a "future" turn
                  // (rewound past, but still in JSONL — the user can
                  // re-select to redo). Future rows render dim.
                  const headIdxInOptions =
                    activeTab === 'conversation' && headLeafUuid
                      ? messageOptions.findIndex(m => m.uuid === headLeafUuid)
                      : -1
                  const isFutureRow =
                    activeTab === 'conversation' &&
                    headIdxInOptions !== -1 &&
                    optionIndex < headIdxInOptions
                  // File-tab rows now come from the row model, keyed by hash.
                  const isHashCodeRow = codeRowByRowId.has(msg.uuid)
                  const isSyntheticAnchorRow = false

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

                  // Time text rendered at the end of the stats row.
                  // formatAgeOrAbsolute matches /checkpoints list rules
                  // (just now / Nm ago / Nh ago / YYYY-MM-DD HH:MM).
                  // Anchor lookup may miss for the (current) row or a
                  // turn that never produced a snapshot; in those
                  // cases we leave it empty.
                  const rowAnchor = anchorByMsgId.get(msg.uuid)
                  const rowCode = codeRowForUuid(msg.uuid)
                  const rowTimeText = rowCode
                    ? formatAgeOrAbsolute(new Date(rowCode.timestamp).getTime() / 1000)
                    : rowAnchor
                      ? formatAgeOrAbsolute(
                          new Date(rowAnchor.timestamp).getTime() / 1000,
                        )
                      : ''

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
                          <UserMessageOption
                            userMessage={msg}
                            color={isSelected ? 'suggestion' : undefined}
                            isCurrent={isCurrent}
                            paddingRight={10}
                            prefix={
                              activeTab === 'code' &&
                              !isCurrent &&
                              !isHashCodeRow &&
                              !isSyntheticAnchorRow
                                ? 'Before '
                                : undefined
                            }
                            shrinkToContent={activeTab === 'conversation'}
                            dimColor={
                              activeTab === 'conversation' &&
                              isFutureRow &&
                              !isSelected
                            }
                          />
                          {/* Conversation-axis head pointer indicator:
                              the row whose uuid equals the resolved head
                              leaf gets a "(current)" tag at the row's
                              end. Drives the user's "where am I right
                              now" sense in the conversation tab; selection
                              cursor (▶) is independent. */}
                          {!isCurrent &&
                            activeTab === 'conversation' &&
                            headLeafUuid !== undefined &&
                            msg.uuid === headLeafUuid && (
                              <Text dimColor italic>
                                {' '}
                                (current)
                              </Text>
                            )}
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
                            {rowTimeText && (
                              // Per-row time at the end of the stats
                              // row, same shape /checkpoints list uses.
                              // Two-space gap separates it visually
                              // from the diff badge.
                              <Text dimColor color="inactive">
                                {'  '}
                                {rowTimeText}
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
                {codeRows.some(row => row.kind === 'pre-rewind') && (
                  <>
                    {`↶ rows restore older state`}
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
  prefix,
  shrinkToContent,
}: {
  userMessage: UserMessage
  color?: keyof Theme
  dimColor?: boolean
  isCurrent: boolean
  paddingRight?: number
  prefix?: string
  /** Conversation tab passes true so the prompt Text shrinks to its
   *  content width — letting the (current) tag sibling sit right next
   *  to the prompt. File tab leaves it false to preserve the legacy
   *  width:100% wrapper (no sibling, but baseline visual unchanged). */
  shrinkToContent?: boolean
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

  // User prompts. File tab keeps the baseline `<Box width="100%">`
  // wrapper so its layout matches main exactly. Conversation tab
  // collapses to a bare <Text> so the sibling (current) tag in the
  // parent flex-row can sit immediately after the prompt content;
  // width:100% there would push (current) to the far right.
  if (shrinkToContent) {
    return (
      <Text color={color} dimColor={dimColor}>
        {prefix ?? ''}
        {paddingRight
          ? truncate(messageText, columns - paddingRight, true)
          : messageText.slice(0, 500).split('\n').slice(0, 4).join('\n')}
      </Text>
    )
  }
  return (
    <Box flexDirection="row" width="100%">
      <Text color={color} dimColor={dimColor}>
        {prefix ?? ''}
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
