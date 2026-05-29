import { type ReactNode, useEffect, useMemo } from 'react'
import {
  type Notification,
  useNotifications,
} from '../../context/notifications.js'
import { useAppState } from '../../state/AppState.js'
import { useVoiceState } from '../../context/voice.js'
type VerificationStatus = 'loading' | 'valid' | 'invalid' | 'missing' | 'error'
import { getGlobalConfig } from '../../utils/config.js'
import type { IDESelection } from '../../hooks/useIdeSelection.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { useVoiceEnabled } from '../../hooks/useVoiceEnabled.js'
import { Box, Text } from '../../ink.js'
import { calculateTokenWarningState } from '../../services/compact/autoCompact.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import type { Message } from '../../types/message.js'
import { getExternalEditor } from '../../utils/editor.js'
import { setEnvHookNotifier } from '../../utils/hooks/fileChangedWatcher.js'
import { toIDEDisplayName } from '../../utils/ide.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'
import { tokenCountFromLastAPIResponse } from '../../utils/tokens.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'
import { IdeStatusIndicator } from '../IdeStatusIndicator.js'
import { ErrorBoundary } from '../ErrorBoundary.js'
import { TokenWarning } from '../TokenWarning.js'
import { SandboxPromptFooterHint } from './SandboxPromptFooterHint.js'

import { VoiceIndicator } from './VoiceIndicator.js'

export const FOOTER_TEMPORARY_STATUS_TIMEOUT = 5000

type Props = {
  apiKeyStatus: VerificationStatus
  debug: boolean
  verbose: boolean
  messages: Message[]
  ideSelection: IDESelection | undefined
  mcpClients?: MCPServerConnection[]
  isInputWrapped?: boolean
  isNarrow?: boolean
}

export function Notifications({
  apiKeyStatus: rawApiKeyStatus,
  debug,
  verbose,
  messages,
  ideSelection,
  mcpClients,
  isInputWrapped = false,
  isNarrow = false,
}: Props): ReactNode {
  // axiomate: each model carries its own apiKey in config.models,
  // so the global API key verification is irrelevant once any model is configured.
  const apiKeyStatus: VerificationStatus = getGlobalConfig().models ? 'valid' : rawApiKeyStatus

  const tokenUsage = useMemo(() => {
    const messagesForTokenCount = getMessagesAfterCompactBoundary(messages)
    return tokenCountFromLastAPIResponse(messagesForTokenCount)
  }, [messages])
  const visibleTokenUsage = tokenUsage > 0 ? tokenUsage : null

  // AppState-sourced model — same source as API requests. Avoid resolving
  // from global route config here so another session's /model write does not
  // leak into this session's display.
  const mainLoopModel = useMainLoopModel()
  const isShowingCompactMessage = calculateTokenWarningState(
    visibleTokenUsage ?? 0,
    mainLoopModel,
  ).isAboveWarningThreshold
  const notifications = useAppState(s => s.notifications)
  const { addNotification, removeNotification } = useNotifications()
  // Register env hook notifier for CwdChanged/FileChanged feedback
  useEffect(() => {
    setEnvHookNotifier((text, isError) => {
      addNotification({
        key: 'env-hook',
        text,
        color: isError ? 'error' : undefined,
        priority: isError ? 'medium' : 'low',
        timeoutMs: isError ? 8000 : 5000,
      })
    })
    return () => setEnvHookNotifier(null)
  }, [addNotification])

  // Check if the external editor hint should be shown
  const editor = getExternalEditor()
  const shouldShowExternalEditorHint =
    isInputWrapped &&
    !isShowingCompactMessage &&
    apiKeyStatus !== 'invalid' &&
    apiKeyStatus !== 'missing' &&
    editor !== undefined

  // Show external editor hint as notification when input is wrapped
  useEffect(() => {
    if (shouldShowExternalEditorHint && editor) {
      addNotification({
        key: 'external-editor-hint',
        jsx: (
          <Text dimColor>
            <ConfigurableShortcutHint
              action="chat:externalEditor"
              context="Chat"
              fallback="ctrl+g"
              description={`edit in ${toIDEDisplayName(editor)}`}
            />
          </Text>
        ),
        priority: 'immediate',
        timeoutMs: 5000,
      })
    } else {
      removeNotification('external-editor-hint')
    }
  }, [
    shouldShowExternalEditorHint,
    editor,
    addNotification,
    removeNotification,
  ])

  return (
    <ErrorBoundary>
      <Box
        flexDirection="column"
        alignItems={isNarrow ? 'flex-start' : 'flex-end'}
        flexShrink={0}
        overflowX="hidden"
      >
        <NotificationContent
          ideSelection={ideSelection}
          mcpClients={mcpClients}
          notifications={notifications}
          apiKeyStatus={apiKeyStatus}
          debug={debug}
          verbose={verbose}
          visibleTokenUsage={visibleTokenUsage}
          mainLoopModel={mainLoopModel}
        />
      </Box>
    </ErrorBoundary>
  )
}

function NotificationContent({
  ideSelection,
  mcpClients,
  notifications,
  apiKeyStatus,
  debug,
  verbose,
  visibleTokenUsage,
  mainLoopModel,
}: {
  ideSelection: IDESelection | undefined
  mcpClients?: MCPServerConnection[]
  notifications: {
    current: Notification | null
    queue: Notification[]
  }
  apiKeyStatus: VerificationStatus
  debug: boolean
  verbose: boolean
  visibleTokenUsage: number | null
  mainLoopModel: string
}): ReactNode {
  const voiceState = useVoiceState(s => s.voiceState)
  const voiceEnabled = useVoiceEnabled()
  const voiceError = useVoiceState(s => s.voiceError)

  // When voice is actively recording or processing, replace all
  // notifications with just the voice indicator.
  if (
    voiceEnabled &&
    (voiceState === 'recording' || voiceState === 'processing')
  ) {
    return <VoiceIndicator voiceState={voiceState} />
  }

  return (
    <>
      <IdeStatusIndicator ideSelection={ideSelection} mcpClients={mcpClients} />
      {notifications.current &&
        ('jsx' in notifications.current ? (
          <Text wrap="truncate" key={notifications.current.key}>
            {notifications.current.jsx}
          </Text>
        ) : (
          <Text
            color={notifications.current.color}
            dimColor={!notifications.current.color}
            wrap="truncate"
          >
            {notifications.current.text}
          </Text>
        ))}
      {(apiKeyStatus === 'invalid' || apiKeyStatus === 'missing') && (
        <Box>
          <Text color="error" wrap="truncate">
            Invalid API key · Check models config in ~/.axiomate.json
          </Text>
        </Box>
      )}
      {debug && (
        <Box>
          <Text color="warning" wrap="truncate">
            Debug mode
          </Text>
        </Box>
      )}
      {apiKeyStatus !== 'invalid' &&
        apiKeyStatus !== 'missing' &&
        verbose &&
        visibleTokenUsage !== null && (
        <Box>
          <Text dimColor wrap="truncate">
            {visibleTokenUsage} tokens
          </Text>
        </Box>
      )}
      {visibleTokenUsage !== null && (
        <TokenWarning tokenUsage={visibleTokenUsage} model={mainLoopModel} />
      )}
      {voiceEnabled && voiceError && (
        <Box>
          <Text color="error" wrap="truncate">
            {voiceError}
          </Text>
        </Box>
      )}
      <SandboxPromptFooterHint />
    </>
  )
}
