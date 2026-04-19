import * as React from 'react'
import { useCallback, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { formatAPIError } from '../../services/api/errorUtils.js'
import type { SystemAPIErrorMessage } from '../../types/message.js'
import { useInterval } from 'usehooks-ts'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { MessageResponse } from '../MessageResponse.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import { useNotifications } from '../../context/notifications.js'
import { RateLimitRecovery } from './RateLimitRecovery.js'

const MAX_API_ERROR_CHARS = 1000

type Props = {
  message: SystemAPIErrorMessage
  verbose: boolean
}

export function SystemAPIErrorMessage({
  message: { retryAttempt, error, retryInMs, maxRetries, errorReason },
  verbose,
}: Props): React.ReactNode {
  // Hidden for early retries on external builds to avoid noise. Compute before
  // useInterval so we never register a timer that just drives a null render.
  const hidden = "external" === 'external' && retryAttempt < 4

  const [countdownMs, setCountdownMs] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const done = countdownMs >= retryInMs
  useInterval(
    () => setCountdownMs(ms => ms + 1000),
    hidden || done ? null : 1000,
  )

  // Rate-limit recovery: when retries are exhausted on a rate_limit error,
  // offer an inline picker to switch to another configured model.
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const setAppState = useSetAppState()
  const { addNotification } = useNotifications()
  const config = React.useMemo(() => getGlobalConfig(), [])
  const models = config.models ?? {}
  const currentModelKey =
    mainLoopModel && models[mainLoopModel] ? mainLoopModel : (config.currentModel ?? '')

  const showRateLimitRecovery =
    !dismissed &&
    errorReason === 'rate_limit' &&
    retryAttempt > maxRetries &&
    Object.keys(models).filter(k => k !== currentModelKey).length > 0

  const handleSwitchModel = useCallback(
    (modelKey: string) => {
      saveGlobalConfig(cfg => ({ ...cfg, currentModel: modelKey }))
      setAppState(prev => ({
        ...prev,
        mainLoopModel: modelKey,
        mainLoopModelForSession: null,
      }))
      const label = models[modelKey]?.name ?? modelKey
      addNotification({
        key: 'rate-limit-model-switch',
        text: `Switched to ${label}. Press ↑ Enter to retry your last message.`,
        priority: 'immediate',
        timeoutMs: 6000,
      })
      setDismissed(true)
    },
    [addNotification, models, setAppState],
  )

  if (hidden) {
    return null
  }

  const retryInSecondsLive = Math.max(
    0,
    Math.round((retryInMs - countdownMs) / 1000),
  )

  const formatted = formatAPIError(error)
  const truncated = !verbose && formatted.length > MAX_API_ERROR_CHARS

  // Countdown text only makes sense while retries remain. Once exhausted, the
  // "retryInMs" value is the backoff for a retry that will never happen — hide.
  const retriesExhausted = retryAttempt > maxRetries

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text color="error">
          {truncated
            ? formatted.slice(0, MAX_API_ERROR_CHARS) + '…'
            : formatted}
        </Text>
        {truncated && <CtrlOToExpand />}
        {!retriesExhausted && (
          <Text dimColor>
            Retrying in {retryInSecondsLive}{' '}
            {retryInSecondsLive === 1 ? 'second' : 'seconds'}… (attempt{' '}
            {retryAttempt}/{maxRetries})
            {process.env.API_TIMEOUT_MS
              ? ` · API_TIMEOUT_MS=${process.env.API_TIMEOUT_MS}ms, try increasing it`
              : ''}
          </Text>
        )}
        {showRateLimitRecovery && (
          <RateLimitRecovery
            currentModel={currentModelKey}
            models={models}
            onPick={handleSwitchModel}
            onCancel={() => setDismissed(true)}
          />
        )}
      </Box>
    </MessageResponse>
  )
}
