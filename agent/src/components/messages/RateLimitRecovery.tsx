/**
 * RateLimitRecovery — inline picker shown below a rate_limit SystemAPIErrorMessage
 * after retry attempts are exhausted. Lets the user persist the current
 * default route's primary model without leaving the REPL.
 *
 * The switch is permanent (saveGlobalConfig writes ~/.axiomate.json). After
 * picking, a notification hints the user to press ↑ Enter to resubmit; we do
 * not auto-retry (v1 simplicity).
 */
import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { ModelProviderConfig } from '../../utils/config.js'
import { Select } from '../CustomSelect/select.js'

type Props = {
  currentModel: string
  models: Record<string, ModelProviderConfig>
  onPick: (modelKey: string) => void
  onCancel?: () => void
}

/**
 * Extract a short provider hostname from a baseUrl (e.g.
 * "https://api.siliconflow.cn/v1" → "siliconflow.cn").
 */
function baseUrlHost(baseUrl: string): string {
  try {
    const u = new URL(baseUrl)
    return u.hostname.replace(/^(api|www)\./, '')
  } catch {
    return baseUrlOr(baseUrl)
  }
}

function baseUrlOr(s: string): string {
  return s.length > 40 ? s.slice(0, 40) + '…' : s
}

export function RateLimitRecovery({
  currentModel,
  models,
  onPick,
  onCancel,
}: Props): React.ReactNode {
  const options = React.useMemo(() => {
    return Object.entries(models)
      .filter(([key]) => key !== currentModel)
      .map(([key, cfg]) => ({
        label: (
          <Text>
            {cfg.name ?? key}
            <Text dimColor>  ·  {baseUrlHost(cfg.baseUrl)}</Text>
          </Text>
        ),
        value: key,
      }))
  }, [currentModel, models])

  if (options.length === 0) {
    return null
  }

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={1}>
      <Text dimColor>
        Rate-limited. Set current default route primary to another configured
        model? (Esc to dismiss)
      </Text>
      <Select options={options} onChange={onPick} onCancel={onCancel} />
    </Box>
  )
}
