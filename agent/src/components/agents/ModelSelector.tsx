import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { getAgentModelOptions } from '../../utils/model/agent.js'
import { Select } from '../CustomSelect/select.js'

interface ModelSelectorProps {
  initialModel?: string
  onComplete: (model?: string) => void
  onCancel?: () => void
}

export function ModelSelector({
  initialModel,
  onComplete,
  onCancel,
}: ModelSelectorProps): React.ReactNode {
  const modelOptions = React.useMemo(() => {
    const base = getAgentModelOptions()
    // If the agent's current model is a configured key not in the picker list, inject
    // it as an option so it can round-trip through confirm without being
    // overwritten.
    if (initialModel && !base.some(o => o.value === initialModel)) {
      return [
        {
          value: initialModel,
          label: initialModel,
          description: 'Current model (custom ID)',
        },
        ...base,
      ]
    }
    return base
  }, [initialModel])

  // Default to 'inherit' so sub-agents reuse the main-loop model — users
  // can be on any provider, so there's no sensible hardcoded fallback alias.
  const defaultModel = initialModel ?? 'inherit'

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text dimColor>
          Model determines the agent&apos;s reasoning capabilities and speed.
        </Text>
      </Box>
      <Select
        options={modelOptions}
        defaultValue={defaultModel}
        onChange={onComplete}
        onCancel={() => (onCancel ? onCancel() : onComplete(undefined))}
      />
    </Box>
  )
}
