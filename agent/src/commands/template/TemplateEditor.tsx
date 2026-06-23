import * as React from 'react'
import { Box, Text } from '../../ink.js'
import chalk from 'chalk'
import { Select } from '../../components/CustomSelect/select.js'
import TextInput from '../../components/TextInput.js'
import {
  getGlobalConfig,
  saveModelTemplateToConfig,
  saveTemplateToConfig,
} from '../../utils/config.js'
import { editJsonInEditor } from '../../utils/promptEditor.js'
import {
  getBuiltinModelTemplates,
  getBuiltinTemplates,
  isBuiltinModelTemplate,
  isBuiltinVendor,
  PROTOCOLS,
  resolveTemplate,
  type ModelTemplate,
  type VendorTemplate,
} from '../../services/api/vendorTemplates.js'
import {
  ModelTemplateSchema,
  VendorTemplateSchema,
} from '../../utils/modelConfigSchema.js'
import {
  initialTemplateEditorState,
  makeInitialState,
  templateEditorReducer,
  type TemplateEditorAction,
  type TemplateKind,
} from './TemplateEditor.reducer.js'

const EXTENDS_OPTIONS = [
  {
    label: 'openai-chat — generic OpenAI Chat Completions reasoning_effort',
    value: 'openai-chat',
  },
  {
    label: 'openai-responses — OpenAI Responses API (GPT-5)',
    value: 'openai-responses',
  },
  {
    label: 'anthropic — Anthropic Messages API (thinking + output_config)',
    value: 'anthropic',
  },
  {
    label: 'openai-chat-deepseek-official — DeepSeek official API gateway shape',
    value: 'openai-chat-deepseek-official',
  },
  {
    label: 'openai-chat-aliyun — aliyun DashScope (max → xhigh)',
    value: 'openai-chat-aliyun',
  },
  {
    label: 'openai-chat-siliconflow — SiliconFlow (high/max)',
    value: 'openai-chat-siliconflow',
  },
  { label: 'None — write from scratch', value: '__none__' },
]

const SCRATCH_INITIAL_VENDOR: VendorTemplate = {}

const SCRATCH_INITIAL_MODEL: ModelTemplate = {
  // matchModelRegex is required so the onboarding wizard can recommend this
  // template and explicit modelTemplate pins can be compatibility-checked.
  matchModelRegex: 'CHANGE_ME — regex against the model name',
}

/**
 * Three-step interactive flow for vendor templates ('name' → 'extends' →
 * 'opening'); two-step for model templates ('name' → 'opening', no
 * extends since model templates don't inherit).
 *
 * Reducer-driven (matches OnboardingProviderStep idiom). The spawn-editor
 * side effect runs in a useEffect keyed on phase === 'opening'.
 */
export function TemplateEditor({
  kind = 'vendor',
  onComplete,
  onCancel,
}: {
  kind?: TemplateKind
  onComplete: (templateName: string) => void
  onCancel: (reason?: string) => void
}): React.ReactNode {
  const [state, dispatch] = React.useReducer(
    templateEditorReducer,
    kind,
    makeInitialState,
  )

  // Side effect: open the editor on each entry into 'opening' phase.
  // Either fresh (no reusePath) or Re-edit (with reusePath).
  React.useEffect(() => {
    if (state.phase !== 'opening') return

    // Build a schema that ALSO dry-resolves the about-to-save template
    // against the live custom registry. This catches typos in `extends`
    // (e.g. 'openai-defaut'), cycles, exceeded depth, and (for vendor
    // templates) protocol issues at save time — surfacing through the
    // same Re-edit flow as Zod field errors.
    const dryResolveSchema =
      state.kind === 'vendor'
        ? buildDryResolveSchema(state.name)
        : (ModelTemplateSchema as unknown as import('zod').ZodSchema<ModelTemplate>)

    const initial =
      state.kind === 'vendor'
        ? buildInitialVendorTemplate(state.baseName)
        : SCRATCH_INITIAL_MODEL

    if (!state.reusePath) {
      const result = editJsonInEditor({
        initialContent: JSON.stringify(initial, null, 2) + '\n',
        schema: dryResolveSchema as never,
        filenameHint: `axiomate-${state.kind}-template-${state.name.replace(
          /[^A-Za-z0-9]/g,
          '_',
        )}`,
      })
      handleEditorResult(result, state.kind, state.name, onComplete, onCancel, dispatch)
      return
    }

    const result = editJsonInEditor({
      mode: 'reuse',
      reusePath: state.reusePath,
      schema: dryResolveSchema as never,
    })
    handleEditorResult(result, state.kind, state.name, onComplete, onCancel, dispatch)
  }, [
    state.phase,
    state.phase === 'opening' ? state.kind : undefined,
    state.phase === 'opening' ? state.name : undefined,
    state.phase === 'opening' ? state.baseName : undefined,
    state.phase === 'opening' ? state.reusePath : undefined,
    onComplete,
    onCancel,
  ])

  if (state.phase === 'name') {
    return (
      <NameStep
        kind={state.kind}
        onSubmit={name => dispatch({ type: 'submitName', name })}
        onCancel={() => {
          onCancel('Template creation cancelled')
          dispatch({ type: 'cancel' })
        }}
      />
    )
  }

  if (state.phase === 'extends') {
    return (
      <ExtendsStep
        templateName={state.name}
        onSubmit={baseName => dispatch({ type: 'submitExtends', baseName })}
        onBack={() => dispatch({ type: 'backToName' })}
      />
    )
  }

  if (state.phase === 'invalid') {
    return (
      <RetryPrompt
        error={state.error}
        onRetry={() => dispatch({ type: 'retry' })}
        onCancel={() => {
          onCancel('Template creation cancelled')
          dispatch({ type: 'cancel' })
        }}
      />
    )
  }

  return null
}

export function buildInitialVendorTemplate(baseName: string): VendorTemplate {
  if (baseName === '__none__') return SCRATCH_INITIAL_VENDOR
  if (PROTOCOLS.includes(baseName as (typeof PROTOCOLS)[number])) {
    return { extends: baseName } as VendorTemplate
  }
  const builtins = getBuiltinTemplates()
  if (baseName in builtins) {
    const { extends: _parent, ...baseTemplate } =
      builtins[baseName as keyof typeof builtins]
    return {
      ...baseTemplate,
      extends: baseName,
    } as VendorTemplate
  }
  return SCRATCH_INITIAL_VENDOR
}

/**
 * Produce a schema that wraps VendorTemplateSchema with a superRefine
 * pass calling resolveTemplate. Captures the live custom-template
 * registry by closure so a successful parse not only validates field
 * shape but also confirms the extends chain resolves and the merged
 * template ends up with non-empty `protocols`.
 *
 * Surfaces failures through the same path as a Zod field error — meaning
 * editJsonInEditor returns ok:false with a useful error message, and
 * handleEditorResult dispatches editorInvalid → TUI shows Re-edit prompt.
 */
export function buildDryResolveSchema(
  templateName: string,
): import('zod').ZodSchema<VendorTemplate> {
  return VendorTemplateSchema.superRefine((parsed, ctx) => {
    const known = {
      ...(getGlobalConfig().templates ?? {}),
      [templateName]: parsed as VendorTemplate,
    }
    try {
      resolveTemplate(templateName, known)
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }) as unknown as import('zod').ZodSchema<VendorTemplate>
}

function handleEditorResult(
  result: ReturnType<typeof editJsonInEditor>,
  kind: TemplateKind,
  name: string,
  onComplete: (templateName: string) => void,
  onCancel: (reason?: string) => void,
  dispatch: React.Dispatch<TemplateEditorAction>,
): void {
  if (result.ok) {
    if (kind === 'vendor') {
      saveTemplateToConfig(name, result.value as VendorTemplate)
    } else {
      saveModelTemplateToConfig(name, result.value as ModelTemplate)
    }
    onComplete(name)
    dispatch({ type: 'editorSucceeded' })
    return
  }
  if ('cancelled' in result && result.cancelled) {
    onCancel('No changes saved')
    dispatch({ type: 'editorCancelled' })
    return
  }
  if ('error' in result) {
    dispatch({
      type: 'editorInvalid',
      error: result.error,
      tempPath: result.tempPath,
    })
  }
}

function NameStep({
  kind,
  onSubmit,
  onCancel,
}: {
  kind: TemplateKind
  onSubmit: (name: string) => void
  onCancel: () => void
}): React.ReactNode {
  const [value, setValue] = React.useState('')
  const [cursor, setCursor] = React.useState(0)
  const [error, setError] = React.useState<string | undefined>()

  function handleSubmit(input: string): void {
    const name = input.trim()
    if (!name) {
      setError('Name is required')
      return
    }
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      setError('Name must be alphanumeric (with - or _ allowed)')
      return
    }
    if (kind === 'vendor') {
      if (isBuiltinVendor(name)) {
        setError(`'${name}' is a built-in vendor template; pick a different name`)
        return
      }
      if (name in (getGlobalConfig().templates ?? {})) {
        setError(
          `A custom vendor template '${name}' already exists; pick a different name (or /template vendor delete first)`,
        )
        return
      }
    } else {
      if (isBuiltinModelTemplate(name)) {
        setError(`'${name}' is a built-in model template; pick a different name`)
        return
      }
      if (name in (getGlobalConfig().modelTemplates ?? {})) {
        setError(
          `A custom model template '${name}' already exists; pick a different name (or /template model delete first)`,
        )
        return
      }
    }
    onSubmit(name)
  }

  const headline =
    kind === 'vendor' ? 'New vendor template' : 'New model template'
  const hint =
    kind === 'vendor'
      ? 'Pick a unique name (alphanumeric, dashes, underscores). Used as `vendor` in your model entries.'
      : 'Pick a unique name (alphanumeric, dashes, underscores). Used as `modelTemplate` in your model entries; matchModelRegex powers wizard recommendations and compatibility checks.'

  return (
    <Box flexDirection="column" paddingLeft={1} gap={1}>
      <Text bold>{headline}</Text>
      <Text dimColor>{hint}</Text>
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
          columns={60}
        />
      </Box>
      {error && <Text color="error">{error}</Text>}
      <Text dimColor>Enter to continue · Esc to cancel</Text>
    </Box>
  )
}

function ExtendsStep({
  templateName,
  onSubmit,
  onBack,
}: {
  templateName: string
  onSubmit: (baseName: string) => void
  onBack: () => void
}): React.ReactNode {
  return (
    <Box flexDirection="column" paddingLeft={1} gap={1}>
      <Text bold>Base template for '{chalk.cyan(templateName)}'</Text>
      <Text dimColor>
        Pick a built-in to inherit from (recommended — gives you a working
        starting point). Your editor will open with that template prefilled.
      </Text>
      <Select options={EXTENDS_OPTIONS} onChange={onSubmit} onCancel={onBack} />
      <Text dimColor>Esc to go back</Text>
    </Box>
  )
}

function RetryPrompt({
  error,
  onRetry,
  onCancel,
}: {
  error: string
  onRetry: () => void
  onCancel: () => void
}): React.ReactNode {
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text color="error">Template failed validation:</Text>
        <Text color="error">{error}</Text>
      </Box>
      <Select
        options={[
          { label: 'Re-edit (preserves your typed JSON)', value: 'retry' },
          { label: 'Cancel — discard changes', value: 'cancel' },
        ]}
        onChange={v => {
          if (v === 'retry') onRetry()
          else onCancel()
        }}
        onCancel={onCancel}
      />
    </Box>
  )
}
