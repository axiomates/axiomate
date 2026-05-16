import * as React from 'react'
import { Box, Text } from '../../ink.js'
import chalk from 'chalk'
import { Select } from '../../components/CustomSelect/select.js'
import TextInput from '../../components/TextInput.js'
import {
  getGlobalConfig,
  saveTemplateToConfig,
} from '../../utils/config.js'
import { editJsonInEditor } from '../../utils/promptEditor.js'
import {
  getBuiltinTemplates,
  isBuiltinVendor,
  type VendorTemplate,
} from '../../services/api/vendorTemplates.js'
import { VendorTemplateSchema } from '../../utils/modelConfigSchema.js'
import {
  initialTemplateEditorState,
  templateEditorReducer,
  type TemplateEditorAction,
} from './TemplateEditor.reducer.js'

const EXTENDS_OPTIONS = [
  {
    label: 'openai-default — generic OpenAI Chat Completions reasoning_effort',
    value: 'openai-default',
  },
  {
    label: 'openai-responses — OpenAI Responses API (o-series, GPT-5)',
    value: 'openai-responses',
  },
  {
    label: 'anthropic — Anthropic Messages API (thinking + output_config)',
    value: 'anthropic',
  },
  {
    label: 'deepseek-reasoning — DeepSeek V4+ (thinking + reasoning_effort)',
    value: 'deepseek-reasoning',
  },
  {
    label: 'openai-ali-thinking — aliyun DashScope (max → xhigh)',
    value: 'openai-ali-thinking',
  },
  {
    label: 'openai-siliconflow-thinking — SiliconFlow (max → max)',
    value: 'openai-siliconflow-thinking',
  },
  { label: 'None — write from scratch', value: '__none__' },
]

const SCRATCH_INITIAL_TEMPLATE: VendorTemplate = {}

/**
 * Three-step interactive flow to create a new vendor template:
 *   1. Enter name (validated against built-in names + existing custom names)
 *   2. Pick `extends` (one of 5 builtins, or None)
 *   3. Spawn $EDITOR prefilled with the chosen base + Zod-validate the result
 *
 * Reducer-driven (matches OnboardingProviderStep idiom). The spawn-editor
 * side effect runs in a useEffect keyed on phase === 'opening'.
 */
export function TemplateEditor({
  onComplete,
  onCancel,
}: {
  onComplete: (templateName: string) => void
  onCancel: (reason?: string) => void
}): React.ReactNode {
  const [state, dispatch] = React.useReducer(
    templateEditorReducer,
    initialTemplateEditorState,
  )

  // Side effect: open the editor on each entry into 'opening' phase.
  // Either fresh (no reusePath) or Re-edit (with reusePath).
  React.useEffect(() => {
    if (state.phase !== 'opening') return

    if (!state.reusePath) {
      const initial = buildInitialTemplate(state.baseName)
      const result = editJsonInEditor<VendorTemplate>({
        initialContent: JSON.stringify(initial, null, 2) + '\n',
        schema: VendorTemplateSchema as unknown as import('zod').ZodSchema<
          VendorTemplate
        >,
        filenameHint: `axiomate-template-${state.name.replace(
          /[^A-Za-z0-9]/g,
          '_',
        )}`,
      })
      handleEditorResult(result, state.name, onComplete, onCancel, dispatch)
      return
    }

    const result = editJsonInEditor<VendorTemplate>({
      mode: 'reuse',
      reusePath: state.reusePath,
      schema: VendorTemplateSchema as unknown as import('zod').ZodSchema<
        VendorTemplate
      >,
    })
    handleEditorResult(result, state.name, onComplete, onCancel, dispatch)
  }, [
    state.phase,
    state.phase === 'opening' ? state.name : undefined,
    state.phase === 'opening' ? state.baseName : undefined,
    state.phase === 'opening' ? state.reusePath : undefined,
    onComplete,
    onCancel,
  ])

  if (state.phase === 'name') {
    return (
      <NameStep
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

function buildInitialTemplate(baseName: string): VendorTemplate {
  if (baseName === '__none__') return SCRATCH_INITIAL_TEMPLATE
  const builtins = getBuiltinTemplates()
  if (baseName in builtins) {
    return {
      extends: baseName,
      ...builtins[baseName as keyof typeof builtins],
    } as VendorTemplate
  }
  return SCRATCH_INITIAL_TEMPLATE
}

function handleEditorResult(
  result: ReturnType<typeof editJsonInEditor<VendorTemplate>>,
  name: string,
  onComplete: (templateName: string) => void,
  onCancel: (reason?: string) => void,
  dispatch: React.Dispatch<TemplateEditorAction>,
): void {
  if (result.ok) {
    saveTemplateToConfig(name, result.value)
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
  onSubmit,
  onCancel,
}: {
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
    if (isBuiltinVendor(name)) {
      setError(`'${name}' is a built-in template; pick a different name`)
      return
    }
    if (name in (getGlobalConfig().templates ?? {})) {
      setError(
        `A custom template '${name}' already exists; pick a different name (or /template delete first)`,
      )
      return
    }
    onSubmit(name)
  }

  return (
    <Box flexDirection="column" paddingLeft={1} gap={1}>
      <Text bold>New vendor template</Text>
      <Text dimColor>
        Pick a unique name (alphanumeric, dashes, underscores). Used as `vendor`
        in your model entries.
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
