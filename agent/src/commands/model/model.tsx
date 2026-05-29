import chalk from 'chalk'
import * as React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { ModelPicker } from '../../components/ModelPicker.js'
import { OnboardingProviderStep } from '../../components/OnboardingProviderStep.js'
import type { OnboardingRouteUsageResult } from '../../components/OnboardingProviderStep.reducer.js'
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../constants/xml.js'
import {
  logEvent,
} from '../../services/analytics/index.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getGlobalConfig } from '../../utils/config.js'
import type { EffortLevel } from '../../utils/effort.js'
import {
  getDefaultMainLoopModelSetting,
  renderDefaultModelSetting,
  renderModelName,
} from '../../utils/model/model.js'
import {
  getMainRouteFromConfig,
  resolveMainModelOverride,
  resolveModelChainFromRoute,
  type MainModelOverride,
  type ResolvedModelRoute,
} from '../../utils/model/modelRouting.js'
import { isModelAllowed } from '../../utils/model/modelAllowlist.js'
import { validateModel } from '../../utils/model/validateModel.js'
import { ModelEditor } from './ModelEditor.js'
import { handleModelRouteCommand } from './modelRoutes.js'

function ModelPickerWrapper({
  onDone,
}: {
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}): React.ReactNode {
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const mainLoopModelOverrideForSession = useAppState(
    s => s.mainLoopModelOverrideForSession,
  )
  const setAppState = useSetAppState()
  const sessionRoute = resolveSessionRoute(mainLoopModelOverrideForSession)

  function handleCancel(): void {
    const displayModel = renderModelLabel(mainLoopModel)
    onDone(`Kept model as ${chalk.bold(displayModel)}`, {
      display: 'system',
    })
  }

  function handleSelect(
    model: string | null,
    effort: EffortLevel | undefined,
  ): void {
    setAppState(prev => ({
      ...prev,
      mainLoopModel: model,
      mainLoopModelOverrideForSession: undefined,
    }))

    let message = `Set model to ${chalk.bold(renderModelLabel(model))}`
    if (effort !== undefined) {
      message += ` with ${chalk.bold(effort)} effort`
    }

    onDone(message)
  }

  return (
    <ModelPicker
      initial={mainLoopModel}
      sessionRoute={sessionRoute}
      onSelect={handleSelect}
      onCancel={handleCancel}
      isStandaloneCommand
    />
  )
}

function SetModelAndClose({
  args,
  onDone,
}: {
  args: string
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}): React.ReactNode {
  const setAppState = useSetAppState()
  const model = args === 'default' ? null : args

  React.useEffect(() => {
    async function handleModelChange(): Promise<void> {
      if (model && !isModelAllowed(model)) {
        onDone(
          `Model '${model}' is not available. Your organization restricts model selection.`,
          { display: 'system' },
        )
        return
      }

      // Skip validation for the configured default route.
      if (!model) {
        setModel(null)
        return
      }

      // Validate and set the route primary.
      try {
        const { valid, error } = await validateModel(model)

        if (valid) {
          setModel(model)
        } else {
          onDone(error || `Model '${model}' not found`, {
            display: 'system',
          })
        }
      } catch (error) {
        onDone(`Failed to validate model: ${(error as Error).message}`, {
          display: 'system',
        })
      }
    }

    function setModel(modelValue: string | null): void {
      setAppState(prev => ({
        ...prev,
        mainLoopModel: modelValue,
        mainLoopModelOverrideForSession: undefined,
      }))
      let message = `Set model to ${chalk.bold(renderModelLabel(modelValue))}`

      onDone(message)
    }

    void handleModelChange()
  }, [model, onDone, setAppState])

  return null
}

function AddModelAndClose({
  onDone,
}: {
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}): React.ReactNode {
  const setAppState = useSetAppState()
  return (
    <OnboardingProviderStep
      onDone={result => {
        // OnboardingProviderStep already persisted the new model to
        // ~/.axiomate.json. Only a main-primary route usage should become
        // active immediately; fallback/model-only additions do not imply a
        // session model switch.
        if (result.type === 'main_primary') {
          setAppState(prev => ({
            ...prev,
            mainLoopModel: result.modelId,
            mainLoopModelOverrideForSession: undefined,
          }))
        }
        onDone(renderAddModelResult(result))
      }}
      onCancel={() =>
        onDone('Cancelled — no model added', { display: 'system' })
      }
    />
  )
}

function renderAddModelResult(result: OnboardingRouteUsageResult): string {
  switch (result.type) {
    case 'main_primary':
      return `Added model ${chalk.bold(result.modelId)} and set route ${chalk.bold(result.routeId)} primary`
    case 'main_fallback':
      return `Added model ${chalk.bold(result.modelId)} to route ${chalk.bold(result.routeId)} fallback chain`
    case 'models_only':
      return `Added model ${chalk.bold(result.modelId)}`
  }
}

function ShowModelAndClose({
  onDone,
}: {
  onDone: (result?: string) => void
}): React.ReactNode {
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const mainLoopModelOverrideForSession = useAppState(
    s => s.mainLoopModelOverrideForSession,
  )
  const effortValueByModel = useAppState(s => s.effortValueByModel)
  const config = getGlobalConfig()
  const baseRoute = getMainRouteFromConfig(config)
  const sessionRoute = resolveSessionRoute(mainLoopModelOverrideForSession)
  const activeModel = sessionRoute?.primary ?? mainLoopModel ?? baseRoute.primary
  const effortValue = effortValueByModel?.[activeModel]
  const displayModel = sessionRoute
    ? renderRouteLabel(sessionRoute)
    : renderRouteLabel(baseRoute)
  const effortInfo =
    effortValue !== undefined ? ` (effort: ${effortValue})` : ''

  if (mainLoopModelOverrideForSession && sessionRoute) {
    onDone(
      `Current model route: ${chalk.bold(displayModel)}${effortInfo}\nSession override: ${renderOverrideLabel(mainLoopModelOverrideForSession)}\nBase route: ${renderRouteLabel(baseRoute)}`,
    )
  } else {
    onDone(`Current model route: ${displayModel}${effortInfo}`)
  }

  return null
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  args = args?.trim() || ''
  if (COMMON_INFO_ARGS.includes(args)) {
    return <ShowModelAndClose onDone={onDone} />
  }
  if (COMMON_HELP_ARGS.includes(args)) {
    onDone(
      [
        'Model commands:',
        '  /model                         open model selection',
        '  /model add                     add a provider/model interactively',
        '  /model edit <model-id>         edit one models[model-id] entry',
        '  /model use <model-id>          set active route primary',
        '  /model route list|show [id]    inspect main routes',
        '  /model route <id>              set active route',
        '  /model route create <id> <model-id>',
        '  /model route delete <id>',
        '  /model route rename <from> <to>',
        '  /model route policy <id> allowActions|switchModelOn|recoveryProfile <value>',
        '  /model fallback list|add|remove <model-id>',
        '  /model aux list|show <task>',
        '  /model aux set <task> <model-id>',
        '  /model aux fallback list|add|remove <task> <model-id>',
        '  /model aux policy <task> failure|timeoutMs|allowActions|switchModelOn|recoveryProfile <value>',
      ].join('\n'),
      { display: 'system' },
    )
    return
  }

  if (args === 'add') {
    return <AddModelAndClose onDone={onDone} />
  }

  // /model edit <id>
  const parts = args.split(/\s+/)
  if (parts[0] === 'edit') {
    const modelId = parts.slice(1).join(' ').trim()
    if (!modelId) {
      onDone('Usage: /model edit <model-id>', { display: 'system' })
      return
    }
    return <ModelEditor modelId={modelId} onDone={onDone} />
  }

  const routeCommand = handleModelRouteCommand(args)
  if (routeCommand.handled) {
    if (routeCommand.activeModel !== undefined) {
      return (
        <SetSessionModelAndClose
          model={routeCommand.activeModel}
          message={routeCommand.message}
          onDone={onDone}
        />
      )
    }
    onDone(routeCommand.message, { display: 'system' })
    return
  }

  if (args) {
    return <SetModelAndClose args={args} onDone={onDone} />
  }

  return <ModelPickerWrapper onDone={onDone} />
}

function SetSessionModelAndClose({
  model,
  message,
  onDone,
}: {
  model: string | null
  message: string
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}): React.ReactNode {
  const setAppState = useSetAppState()
  React.useEffect(() => {
    setAppState(prev => ({
      ...prev,
      mainLoopModel: model,
      mainLoopModelOverrideForSession: undefined,
    }))
    onDone(message, { display: 'system' })
  }, [message, model, onDone, setAppState])
  return null
}

function renderModelLabel(model: string | null): string {
  const rendered = renderDefaultModelSetting(
    model ?? getDefaultMainLoopModelSetting(),
  )
  return model === null ? `${rendered} (default)` : rendered
}

function resolveSessionRoute(
  override: MainModelOverride | undefined,
): ResolvedModelRoute | undefined {
  if (!override) return undefined
  try {
    return resolveMainModelOverride(getGlobalConfig(), override)
  } catch {
    return undefined
  }
}

function renderRouteLabel(route: ResolvedModelRoute): string {
  const chain = resolveModelChainFromRoute(route).map(renderModelName)
  if (route.id.startsWith('session:')) {
    return chain[0] ?? route.primary
  }
  return `${route.id}: ${chain.join(' -> ')}`
}

function renderOverrideLabel(override: MainModelOverride): string {
  if (override.type === 'default-route') return 'default route'
  if (override.type === 'route') return `route ${override.routeId}`
  return `single model ${renderModelName(override.modelId)}`
}
