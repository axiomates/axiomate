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
import { useAppState } from '../state/AppState.js'
import {
  type DiffStats,
  fileHistoryCanRestore,
  fileHistoryEnabled,
  fileHistoryGetDiffStats,
  fileHistoryHasExactSnapshot,
} from '../utils/fileHistory.js'
import { logError } from '../utils/log.js'
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
import type { FileEditOutput } from '../tools/FileEditTool/types.js'
import type { Output as FileWriteToolOutput } from '../tools/FileWriteTool/FileWriteTool.js'
import {
  BASH_STDERR_TAG,
  BASH_STDOUT_TAG,
  COMMAND_MESSAGE_TAG,
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
  | 'both'
  | 'conversation'
  | 'code'
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
  onRestoreMessage: (message: UserMessage) => Promise<void>
  onRestoreCode: (message: UserMessage) => Promise<void>
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
  const fileHistory = useAppState(s => s.fileHistory)
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
  const [showAllTurns, setShowAllTurns] = useState(false)
  const allSelectable = useMemo(
    () => messages.filter(selectableUserMessagesFilter),
    [messages],
  )
  const hasAnySnapshot =
    isFileHistoryEnabled && fileHistory.snapshots.length > 0
  const visibleSelectable = useMemo(
    () =>
      showAllTurns || !hasAnySnapshot
        ? allSelectable
        : allSelectable.filter(m =>
            fileHistoryHasExactSnapshot(fileHistory, m.uuid),
          ),
    [allSelectable, showAllTurns, fileHistory, hasAnySnapshot],
  )
  const hiddenCount = allSelectable.length - visibleSelectable.length

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
    return fileHistory.snapshots
      .filter(s => !conversationUuids.has(s.messageId))
      .map(s => {
        const time = formatSnapshotTime(s.timestamp)
        return {
          ...createUserMessage({
            content: `↶ Pre-rewind anchor (${time})`,
          }),
          uuid: s.messageId,
        } as UserMessage
      })
  }, [fileHistory.snapshots, conversationUuids, isFileHistoryEnabled])

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
    const snapByUuid = new Map(
      fileHistory.snapshots.map(s => [s.messageId, snapshotTimeMs(s.timestamp)]),
    )
    let lastTs = 0
    const realRowsWithTs = visibleSelectable.map(m => {
      const ts = snapByUuid.get(m.uuid)
      if (ts !== undefined) lastTs = ts
      return { row: m, ts: lastTs }
    })
    const synthRowsWithTs = syntheticAnchors.map(m => {
      const ts = snapByUuid.get(m.uuid) ?? 0
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
  }, [visibleSelectable, syntheticAnchors, fileHistory.snapshots, currentUUID])
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
    void fileHistoryGetDiffStats(fileHistory, preselectedMessage.uuid, messages).then(
      stats => {
        if (!cancelled) setDiffStatsForRestore(stats)
      },
    )
    return () => {
      cancelled = true
    }
  }, [preselectedMessage, isFileHistoryEnabled, fileHistory])

  const [isRestoring, setIsRestoring] = useState(false)
  const [restoringOption, setRestoringOption] = useState<RestoreOption | null>(
    null,
  )
  const [selectedRestoreOption, setSelectedRestoreOption] =
    useState<RestoreOption>('both')
  // Per-option feedback state; Select's internal inputValues Map persists
  // per-option text independently, so sharing one variable would desync.
  const [summarizeFromFeedback, setSummarizeFromFeedback] = useState('')
  const [summarizeUpToFeedback, setSummarizeUpToFeedback] = useState('')

  // Generate options with summarize as input type for inline context.
  // `isSynthetic` is set when the selected row is a system-synthesized
  // anchor (pre-rewind safety snapshot) — those have no conversation
  // to fork, so we only offer code-restore + cancel.
  function getRestoreOptions(
    canRestoreCode: boolean,
    isSynthetic: boolean = false,
  ): OptionWithDescription<RestoreOption>[] {
    if (isSynthetic) {
      return [
        { value: 'code', label: 'Restore code' },
        { value: 'nevermind', label: 'Never mind' },
      ]
    }

    const baseOptions: OptionWithDescription<RestoreOption>[] = canRestoreCode
      ? [
          { value: 'both', label: 'Restore code and conversation' },
          { value: 'conversation', label: 'Restore conversation' },
          { value: 'code', label: 'Restore code' },
        ]
      : [{ value: 'conversation', label: 'Restore conversation' }]

    const summarizeInputProps = {
      type: 'input' as const,
      placeholder: 'add context (optional)',
      initialValue: '',
      allowEmptySubmitToCancel: true,
      showLabelWithValue: true,
      labelValueSeparator: ': ',
    }
    baseOptions.push({
      value: 'summarize',
      label: 'Summarize from here',
      ...summarizeInputProps,
      onChange: setSummarizeFromFeedback,
    })

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
      await onRestoreMessage(message)
      setIsRestoring(false)
      onClose()
    } catch (error) {
      logError(error as Error)
      setIsRestoring(false)
      setError(`Failed to restore the conversation:\n${error}`)
    }
  }

  async function handleSelect(message: UserMessage) {
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
      const diffStats = await fileHistoryGetDiffStats(
        fileHistory,
        message.uuid,
        messages,
      )
      setMessageToRestore(message)
      setDiffStatsForRestore(diffStats)
      return
    }

    if (!isFileHistoryEnabled) {
      await restoreConversationDirectly(message)
      return
    }

    const diffStats = await fileHistoryGetDiffStats(fileHistory, message.uuid, messages)
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

    if (option === 'code' || option === 'both') {
      try {
        await onRestoreCode(messageToRestore)
      } catch (error) {
        codeError = error as Error
        logError(codeError)
      }
    }

    if (option === 'conversation' || option === 'both') {
      try {
        await onRestoreMessage(messageToRestore)
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
  const toggleAllTurns = useCallback(() => {
    const currentUuid = messageOptions[selectedIndex]?.uuid ?? null
    setPendingFocusUuid(currentUuid)
    setShowAllTurns(prev => !prev)
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
      'messageSelector:toggleAllTurns': toggleAllTurns,
    },
    {
      context: 'MessageSelector',
      isActive:
        !isRestoring && !error && !messageToRestore && hasMessagesToSelect,
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
    async function loadFileHistoryMetadata() {
      if (!isFileHistoryEnabled) {
        return
      }
      // Load file snapshot metadata
      void Promise.all(
        messageOptions.map(async (userMessage, itemIndex) => {
          if (userMessage.uuid !== currentUUID) {
            const canRestore = fileHistoryCanRestore(
              fileHistory,
              userMessage.uuid,
              messages,
            )

            const nextUserMessage = messageOptions.at(itemIndex + 1)
            const diffStats = canRestore
              ? computeDiffStatsBetweenMessages(
                  messages,
                  userMessage.uuid,
                  nextUserMessage?.uuid !== currentUUID
                    ? nextUserMessage?.uuid
                    : undefined,
                )
              : undefined

            setFileHistoryMetadata(prev => ({
              ...prev,
              [userMessage.uuid]: diffStats,
            }))
          }
        }),
      )
    }
    void loadFileHistoryMetadata()
  }, [messageOptions, messages, currentUUID, fileHistory, isFileHistoryEnabled])

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
            <Text>Nothing to rewind to yet.</Text>
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
                Restore the code and/or conversation to the point before…
              </Text>
            ) : (
              <Text>
                Restore and fork the conversation to the point before…
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

                  const metadataLoaded =
                    !isCurrent && msg.uuid in fileHistoryMetadata
                  const metadata = fileHistoryMetadata[msg.uuid]
                  const numFilesChanged =
                    metadata?.filesChanged && metadata.filesChanged.length

                  return (
                    <Box
                      key={msg.uuid}
                      height={isFileHistoryEnabled ? 3 : 2}
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
                        <Box flexShrink={1} height={1} overflow="hidden">
                          <UserMessageOption
                            userMessage={msg}
                            color={isSelected ? 'suggestion' : undefined}
                            isCurrent={isCurrent}
                            paddingRight={10}
                          />
                        </Box>
                        {isFileHistoryEnabled && metadataLoaded && (
                          <Box height={1} flexDirection="row">
                            {metadata ? (
                              <>
                                <Text dimColor={!isSelected} color="inactive">
                                  {numFilesChanged ? (
                                    <>
                                      {numFilesChanged === 1 &&
                                      metadata.filesChanged![0]
                                        ? `${path.basename(metadata.filesChanged![0])} `
                                        : `${numFilesChanged} files changed `}
                                      <DiffStatsText diffStats={metadata} />
                                    </>
                                  ) : (
                                    <>No code changes</>
                                  )}
                                </Text>
                              </>
                            ) : (
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
                {(hiddenCount > 0 || showAllTurns) && (
                  <>
                    {showAllTurns
                      ? `Tab to show only code-restore anchors (${hiddenCount} hidden)`
                      : `Tab to show all ${allSelectable.length} turns (${hiddenCount} conversation-only)`}
                    {' · '}
                  </>
                )}
                {syntheticAnchors.length > 0 && (
                  <>
                    {`↶ rows undo a previous rewind`}
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
    case 'both':
    case 'conversation':
      return 'The conversation will be forked.'
    case 'code':
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
    canRestoreCode &&
    (selectedRestoreOption === 'both' || selectedRestoreOption === 'code')

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {getRestoreOptionConversationText(selectedRestoreOption)}
      </Text>
      {!isSummarizeOption(selectedRestoreOption) &&
        (showCodeRestore ? (
          <RestoreCodeConfirmation diffStatsForRestore={diffStatsForRestore} />
        ) : (
          <Text dimColor>The code will be unchanged.</Text>
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
 * Computes the diff stats for all the file edits in-between two messages.
 */
function computeDiffStatsBetweenMessages(
  messages: Message[],
  fromMessageId: UUID,
  toMessageId: UUID | undefined,
): DiffStats | undefined {
  const startIndex = messages.findIndex(msg => msg.uuid === fromMessageId)
  if (startIndex === -1) {
    return undefined
  }

  let endIndex = toMessageId
    ? messages.findIndex(msg => msg.uuid === toMessageId)
    : messages.length
  if (endIndex === -1) {
    endIndex = messages.length
  }

  const filesChanged: string[] = []
  let insertions = 0
  let deletions = 0

  for (let i = startIndex + 1; i < endIndex; i++) {
    const msg = messages[i]
    if (!msg || !isToolUseResultMessage(msg)) {
      continue
    }

    const result = msg.toolUseResult as FileEditOutput | FileWriteToolOutput
    if (!result || !result.filePath || !result.structuredPatch) {
      continue
    }

    if (!filesChanged.includes(result.filePath)) {
      filesChanged.push(result.filePath)
    }

    try {
      if ('type' in result && result.type === 'create') {
        insertions += result.content.split(/\r?\n/).length
      } else {
        for (const hunk of result.structuredPatch) {
          const additions = count(hunk.lines, line => line.startsWith('+'))
          const removals = count(hunk.lines, line => line.startsWith('-'))

          insertions += additions
          deletions += removals
        }
      }
    } catch {
      continue
    }
  }

  return {
    filesChanged,
    insertions,
    deletions,
  }
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
  if (
    messageText.indexOf(`<${LOCAL_COMMAND_STDOUT_TAG}>`) !== -1 ||
    messageText.indexOf(`<${LOCAL_COMMAND_STDERR_TAG}>`) !== -1 ||
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
