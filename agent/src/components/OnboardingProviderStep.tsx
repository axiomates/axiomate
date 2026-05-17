import * as React from 'react'
import { useCallback, useReducer, useState } from 'react'

import { Box, Newline, Text, useInput } from '../ink.js'
import { verifyApiKey } from '../services/api/llm.js'
import { saveGlobalConfig, getGlobalConfig } from '../utils/config.js'
import {
  getBuiltinTemplates,
  type VendorTemplateName,
} from '../services/api/vendorTemplates.js'
import { TemplateEditor } from '../commands/template/TemplateEditor.js'
import { Select } from './CustomSelect/select.js'
import TextInput from './TextInput.js'
import {
  buildModelConfig,
  CONTEXT_WINDOW_HINT,
  DEFAULT_BASE_URLS,
  DEFAULT_CONTEXT_WINDOW_VALUE,
  initialOnboardingProviderState,
  MODEL_ID_HINT,
  onboardingProviderReducer,
  THINKING_HINT,
  USER_AGENT_HINT,
  getThinkingChoicesForVendor,
  isThinkingChoiceSupported,
  type OnboardingProviderState,
  type Protocol,
  type ThinkingChoice,
} from './OnboardingProviderStep.reducer.js'

/**
 * Provider-setup sub-wizard. Walks a first-run user through
 * protocol → baseUrl → apiKey → modelId → contextWindow → supportsImages →
 * userAgent → verify → persist.
 *
 * Pure state transitions live in ./OnboardingProviderStep.reducer.ts so
 * tests can exercise them without loading the provider / llm chain.
 */

function persistConfig(state: OnboardingProviderState): void {
  const entry = buildModelConfig(state)
  saveGlobalConfig(current => ({
    ...current,
    models: {
      ...(current.models ?? {}),
      [state.modelId]: entry,
    },
    currentModel: state.modelId,
  }))
}

type Props = {
  onDone: () => void
  onCancel: () => void
}

export function OnboardingProviderStep({
  onDone,
  onCancel,
}: Props): React.ReactNode {
  const [state, dispatch] = useReducer(
    onboardingProviderReducer,
    initialOnboardingProviderState,
  )

  // Run verification as a side effect when we transition into the 'verifying'
  // stage. Persist + advance on success; surface error on failure.
  React.useEffect(() => {
    if (state.stage !== 'verifying') return
    let cancelled = false
    void (async () => {
      try {
        // Temporarily seed the config with the new model so verifyApiKey's
        // getProviderForModel(getFastModel()) resolves to this entry. Without
        // this the fast-model lookup has nothing to resolve to.
        persistConfig(state)
        const ok = await verifyApiKey(state.apiKey, false)
        if (cancelled) return
        if (ok) {
          onDone()
        } else {
          dispatch({
            type: 'verifyFail',
            error: 'Authentication failed — check your API key and try again.',
          })
        }
      } catch (err) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        dispatch({ type: 'verifyFail', error: message })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [state.stage, state, onDone])

  switch (state.stage) {
    case 'protocol':
      return <ProtocolStep onPick={p => dispatch({ type: 'pickProtocol', protocol: p })} onCancel={onCancel} />
    case 'baseUrl':
      return (
        <BaseUrlStep
          protocol={state.protocol}
          initial={state.baseUrl}
          onSubmit={v => dispatch({ type: 'submitBaseUrl', value: v })}
          onBack={() => dispatch({ type: 'back' })}
        />
      )
    case 'apiKey':
      return (
        <ApiKeyStep
          initial={state.apiKey}
          previousError={state.error}
          onSubmit={v => dispatch({ type: 'submitApiKey', value: v })}
          onBack={() => dispatch({ type: 'back' })}
        />
      )
    case 'modelId':
      return (
        <ModelIdStep
          protocol={state.protocol}
          initial={state.modelId}
          onSubmit={v => dispatch({ type: 'submitModelId', value: v })}
          onBack={() => dispatch({ type: 'back' })}
        />
      )
    case 'contextWindow':
      return (
        <ContextWindowStep
          initial={state.contextWindow}
          previousError={state.error}
          onSubmit={v => dispatch({ type: 'submitContextWindow', value: v })}
          onBack={() => dispatch({ type: 'back' })}
        />
      )
    case 'supportsImages':
      return (
        <SupportsImagesStep
          initial={state.supportsImages}
          onSubmit={v => dispatch({ type: 'submitSupportsImages', value: v })}
          onBack={() => dispatch({ type: 'back' })}
        />
      )
    case 'vendor':
      return (
        <VendorStep
          initial={state.vendor}
          onSubmit={v => {
            const customTemplates = getGlobalConfig().templates
            const nextThinking = isThinkingChoiceSupported(
              state.thinking,
              v,
              customTemplates,
            )
              ? state.thinking
              : 'off'
            dispatch({ type: 'submitVendor', value: v, nextThinking })
          }}
          onCreateNew={() => dispatch({ type: 'startCreateTemplate' })}
          onBack={() => dispatch({ type: 'back' })}
        />
      )
    case 'createTemplate':
      return (
        <TemplateEditor
          onComplete={name => {
            const customTemplates = getGlobalConfig().templates
            const nextThinking = isThinkingChoiceSupported(
              state.thinking,
              name,
              customTemplates,
            )
              ? state.thinking
              : 'off'
            dispatch({
              type: 'finishCreateTemplate',
              templateName: name,
              nextThinking,
            })
          }}
          onCancel={() => dispatch({ type: 'cancelCreateTemplate' })}
        />
      )
    case 'thinking':
      return (
        <ThinkingStep
          initial={state.thinking}
          vendor={state.vendor}
          onSubmit={v => dispatch({ type: 'submitThinking', value: v })}
          onBack={() => dispatch({ type: 'back' })}
        />
      )
    case 'userAgent':
      return (
        <UserAgentStep
          initial={state.userAgent}
          onSubmit={v => dispatch({ type: 'submitUserAgent', value: v })}
          onBack={() => dispatch({ type: 'back' })}
        />
      )
    case 'verifying':
      return (
        <Box flexDirection="column" paddingLeft={1} gap={1}>
          <Text bold>Verifying connection…</Text>
          <Text dimColor>Contacting {state.baseUrl} with model {state.modelId}</Text>
        </Box>
      )
    case 'verifyFailed':
      return (
        <VerifyFailedStep
          error={state.error ?? 'Unknown error'}
          onRetry={() => dispatch({ type: 'retryFromApiKey' })}
          onSkip={() => {
            // User opted to skip verification (e.g. local ollama, offline).
            // Config was already persisted optimistically when verify started.
            onDone()
          }}
        />
      )
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function protocolLabel(protocol: Protocol): string {
  switch (protocol) {
    case 'openai-chat':
      return 'OpenAI Chat Completions'
    case 'openai-responses':
      return 'OpenAI Responses API'
    case 'anthropic':
      return 'Anthropic-compatible'
  }
}

function ProtocolStep({
  onPick,
  onCancel,
}: {
  onPick: (p: Protocol) => void
  onCancel: () => void
}): React.ReactNode {
  return (
    <Box flexDirection="column" paddingLeft={1} gap={1}>
      <Text bold>Welcome to Axiomate — set up your first model</Text>
      <Text>
        Which API protocol does your provider speak?
        <Newline />
        <Text dimColor>OpenAI-compatible covers OpenRouter, SiliconFlow, vLLM, ollama, most hosted providers.</Text>
      </Text>
      <Select
        options={[
          { label: 'OpenAI Chat Completions (compatible: OpenRouter, SiliconFlow, vLLM, ollama, ...)', value: 'openai-chat' },
          { label: 'OpenAI Responses API (preferred for reasoning models: o4-mini, o3, gpt-5)', value: 'openai-responses' },
          { label: 'Anthropic-compatible', value: 'anthropic' },
        ]}
        onChange={v => onPick(v as Protocol)}
        onCancel={onCancel}
      />
      <Text dimColor>Esc to cancel setup</Text>
    </Box>
  )
}

function BaseUrlStep({
  protocol,
  initial,
  onSubmit,
  onBack,
}: {
  protocol: Protocol
  initial: string
  onSubmit: (v: string) => void
  onBack: () => void
}): React.ReactNode {
  const seed = initial || DEFAULT_BASE_URLS[protocol]
  const [value, setValue] = useState(seed)
  const [cursor, setCursor] = useState(seed.length)

  const handleSubmit = useCallback(
    (v: string) => {
      const trimmed = v.trim()
      if (!trimmed) return
      onSubmit(trimmed)
    },
    [onSubmit],
  )

  return (
    <Box flexDirection="column" paddingLeft={1} gap={1}>
      <Text bold>API base URL</Text>
      <Text dimColor>
        Default for {protocolLabel(protocol)}: {DEFAULT_BASE_URLS[protocol]}
      </Text>
      <Box flexDirection="row" gap={1}>
        <Text>&gt;</Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          cursorOffset={cursor}
          onChangeCursorOffset={setCursor}
          focus
          showCursor
          columns={80}
        />
      </Box>
      <Text dimColor>Enter to continue · Esc to go back</Text>
      <EscToGoBack onBack={onBack} />
    </Box>
  )
}

function ApiKeyStep({
  initial,
  previousError,
  onSubmit,
  onBack,
}: {
  initial: string
  previousError?: string
  onSubmit: (v: string) => void
  onBack: () => void
}): React.ReactNode {
  const [value, setValue] = useState(initial)
  const [cursor, setCursor] = useState(initial.length)

  const handleSubmit = useCallback(
    (v: string) => {
      if (!v) return
      onSubmit(v)
    },
    [onSubmit],
  )

  // Render a masked display but keep the real value in state for submission.
  // TextInput doesn't have native masking, so we pass a masked echo via
  // a custom onChange that tracks the real value internally.
  return (
    <Box flexDirection="column" paddingLeft={1} gap={1}>
      <Text bold>API key</Text>
      <Text dimColor>
        Stored in ~/.axiomate.json. Keep this file private.
      </Text>
      {previousError && <Text color="error">{previousError}</Text>}
      <Box flexDirection="row" gap={1}>
        <Text>&gt;</Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          cursorOffset={cursor}
          onChangeCursorOffset={setCursor}
          focus
          showCursor
          mask="*"
          columns={80}
        />
      </Box>
      <Text dimColor>Enter to continue · Esc to go back</Text>
      <EscToGoBack onBack={onBack} />
    </Box>
  )
}

function ModelIdStep({
  protocol,
  initial,
  onSubmit,
  onBack,
}: {
  protocol: Protocol
  initial: string
  onSubmit: (v: string) => void
  onBack: () => void
}): React.ReactNode {
  const [value, setValue] = useState(initial)
  const [cursor, setCursor] = useState(initial.length)

  const handleSubmit = useCallback(
    (v: string) => {
      const trimmed = v.trim()
      if (!trimmed) return
      onSubmit(trimmed)
    },
    [onSubmit],
  )

  return (
    <Box flexDirection="column" paddingLeft={1} gap={1}>
      <Text bold>Model ID</Text>
      <Text dimColor>This is the string your provider expects in the `model` field.</Text>
      <Text dimColor>{MODEL_ID_HINT[protocol]}</Text>
      <Box flexDirection="row" gap={1}>
        <Text>&gt;</Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          cursorOffset={cursor}
          onChangeCursorOffset={setCursor}
          focus
          showCursor
          columns={80}
        />
      </Box>
      <Text dimColor>Enter to continue · Esc to go back</Text>
      <EscToGoBack onBack={onBack} />
    </Box>
  )
}

function ContextWindowStep({
  initial,
  previousError,
  onSubmit,
  onBack,
}: {
  initial: number
  previousError?: string
  onSubmit: (v: string) => void
  onBack: () => void
}): React.ReactNode {
  const seed =
    initial && initial !== DEFAULT_CONTEXT_WINDOW_VALUE ? String(initial) : ''
  const [value, setValue] = useState(seed)
  const [cursor, setCursor] = useState(seed.length)

  const handleSubmit = useCallback(
    (v: string) => {
      onSubmit(v)
    },
    [onSubmit],
  )

  return (
    <Box flexDirection="column" paddingLeft={1} gap={1}>
      <Text bold>Context window</Text>
      <Text dimColor>{CONTEXT_WINDOW_HINT}</Text>
      {previousError && <Text color="error">{previousError}</Text>}
      <Box flexDirection="row" gap={1}>
        <Text>&gt;</Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          cursorOffset={cursor}
          onChangeCursorOffset={setCursor}
          focus
          showCursor
          columns={80}
        />
      </Box>
      <Text dimColor>Enter to continue · Esc to go back</Text>
      <EscToGoBack onBack={onBack} />
    </Box>
  )
}

function VendorStep({
  initial,
  onSubmit,
  onCreateNew,
  onBack,
}: {
  initial: string
  onSubmit: (vendorName: string) => void
  onCreateNew: () => void
  onBack: () => void
}): React.ReactNode {
  useInput((_input, key) => {
    if (key.escape) onBack()
  })

  const builtins = Object.keys(getBuiltinTemplates()) as VendorTemplateName[]
  const customs = Object.keys(getGlobalConfig().templates ?? {})

  const options = [
    {
      label: 'Auto-detect (recommended for known providers)',
      value: 'auto',
    },
    ...builtins.map(name => ({
      label: `${name} — built-in`,
      value: name,
    })),
    ...customs.map(name => ({
      label: `${name} — custom`,
      value: name,
    })),
    {
      label: 'Create new template…',
      value: '__create_new__',
    },
  ]

  return (
    <Box flexDirection="column" paddingLeft={1} gap={1}>
      <Text bold>Vendor template</Text>
      <Text dimColor>
        How axiomate translates `thinking: {'{...}'}` into wire fields. Pick
        Auto unless your provider's wire schema doesn't match any built-in
        (then create a new template).
      </Text>
      <Select
        defaultValue={initial}
        options={options}
        onChange={v => {
          if (v === '__create_new__') onCreateNew()
          else onSubmit(v)
        }}
        onCancel={onBack}
      />
      <Text dimColor>Esc to go back</Text>
    </Box>
  )
}

function SupportsImagesStep({
  initial,
  onSubmit,
  onBack,
}: {
  initial: boolean
  onSubmit: (v: boolean) => void
  onBack: () => void
}): React.ReactNode {
  useInput((_input, key) => {
    if (key.escape) onBack()
  })
  return (
    <Box flexDirection="column" paddingLeft={1} gap={1}>
      <Text bold>Image input support</Text>
      <Text dimColor>
        Does this model accept images? Set No for text-only models (DeepSeek,
        most Qwen variants, etc.) — sending an image to a text-only model
        produces an API error.
      </Text>
      <Select
        defaultValue={initial ? 'yes' : 'no'}
        options={[
          { label: 'Yes — accepts images (default)', value: 'yes' },
          { label: 'No — text-only model', value: 'no' },
        ]}
        onChange={v => onSubmit(v === 'yes')}
        onCancel={onBack}
      />
      <EscToGoBack onBack={onBack} />
    </Box>
  )
}

function ThinkingStep({
  initial,
  vendor,
  onSubmit,
  onBack,
}: {
  initial: ThinkingChoice
  vendor: string
  onSubmit: (v: ThinkingChoice) => void
  onBack: () => void
}): React.ReactNode {
  useInput((_input, key) => {
    if (key.escape) onBack()
  })
  const customTemplates = getGlobalConfig().templates
  const allowed = getThinkingChoicesForVendor(vendor, customTemplates)
  const allChoices: { label: string; value: ThinkingChoice }[] = [
    { label: 'Off (no reasoning params sent)', value: 'off' },
    { label: 'Low', value: 'low' },
    { label: 'Medium', value: 'medium' },
    { label: 'High (recommended for reasoning models)', value: 'high' },
    { label: 'Max (for o-series / DeepSeek max)', value: 'max' },
  ]
  const options = allChoices.filter(o => allowed.includes(o.value))
  // 'initial' may be missing from the filtered set (e.g. user switched
  // from a vendor that supports 'low' to one that doesn't); fall back
  // to 'off' which is always present.
  const defaultValue = options.some(o => o.value === initial) ? initial : 'off'
  return (
    <Box flexDirection="column" paddingLeft={1} gap={1}>
      <Text bold>Reasoning depth</Text>
      <Text dimColor>{THINKING_HINT}</Text>
      <Select
        defaultValue={defaultValue}
        options={options}
        onChange={v => onSubmit(v as ThinkingChoice)}
        onCancel={onBack}
      />
      <EscToGoBack onBack={onBack} />
    </Box>
  )
}

function UserAgentStep({
  initial,
  onSubmit,
  onBack,
}: {
  initial: string
  onSubmit: (v: string) => void
  onBack: () => void
}): React.ReactNode {
  const [value, setValue] = useState(initial)
  const [cursor, setCursor] = useState(initial.length)
  return (
    <Box flexDirection="column" paddingLeft={1} gap={1}>
      <Text bold>User-Agent override (optional)</Text>
      <Text dimColor>{USER_AGENT_HINT}</Text>
      <Box flexDirection="row" gap={1}>
        <Text>&gt;</Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={onSubmit}
          cursorOffset={cursor}
          onChangeCursorOffset={setCursor}
          focus
          showCursor
          columns={80}
        />
      </Box>
      <Text dimColor>Enter to continue (empty = keep SDK default) · Esc to go back</Text>
      <EscToGoBack onBack={onBack} />
    </Box>
  )
}

function VerifyFailedStep({
  error,
  onRetry,
  onSkip,
}: {
  error: string
  onRetry: () => void
  onSkip: () => void
}): React.ReactNode {
  return (
    <Box flexDirection="column" paddingLeft={1} gap={1}>
      <Text bold color="error">Connection verification failed</Text>
      <Text color="error">{error}</Text>
      <Text dimColor>
        The config was saved regardless. You can retry with a corrected key, or
        skip verification (useful for local ollama / offline endpoints).
      </Text>
      <Select
        options={[
          { label: 'Retry — back to API key entry', value: 'retry' },
          { label: 'Skip verification and continue', value: 'skip' },
        ]}
        onChange={v => {
          if (v === 'retry') onRetry()
          else onSkip()
        }}
      />
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Keyboard: Esc-to-go-back helper. Ink's useInput only fires for non-input
// keys when focus is on a TextInput with controlled cursor, so handle Esc
// here at a higher tree position.
// ---------------------------------------------------------------------------
function EscToGoBack({ onBack }: { onBack: () => void }): React.ReactNode {
  // Escape isn't a printable character so it doesn't collide with TextInput's
  // own useInput handler.
  useInput((_input, key) => {
    if (key.escape) onBack()
  })
  return null
}
