import type { PermissionMode } from '../permissions/PermissionMode.js'
import { capitalize } from '../stringUtils.js'
import {
  getRuntimeMainLoopModel,
  parseUserSpecifiedModel,
} from './model.js'

export const AGENT_MODEL_OPTIONS = ['inherit'] as const
export type AgentModelChoice = (typeof AGENT_MODEL_OPTIONS)[number]

export type AgentModelOption = {
  value: AgentModelChoice
  label: string
  description: string
}

/**
 * Get the default subagent model. Returns 'inherit' so subagents inherit
 * the model from the parent thread.
 */
export function getDefaultSubagentModel(): string {
  return 'inherit'
}

/**
 * Get the effective model string for an agent. Resolution order:
 *   1. AXIOMATE_CODE_SUBAGENT_MODEL env var (override)
 *   2. Tool-specified model (from AgentTool input)
 *   3. Agent-definition model (the 'model:' field in the agent .md file)
 *   4. 'inherit' — use the parent's effective model
 */
export function getAgentModel(
  agentModel: string | undefined,
  parentModel: string,
  toolSpecifiedModel?: string,
  permissionMode?: PermissionMode,
): string {
  if (process.env.AXIOMATE_CODE_SUBAGENT_MODEL) {
    return parseUserSpecifiedModel(process.env.AXIOMATE_CODE_SUBAGENT_MODEL)
  }

  if (toolSpecifiedModel) {
    return parseUserSpecifiedModel(toolSpecifiedModel)
  }

  const agentModelWithExp = agentModel ?? getDefaultSubagentModel()

  if (agentModelWithExp === 'inherit') {
    return getRuntimeMainLoopModel({
      permissionMode: permissionMode ?? 'default',
      mainLoopModel: parentModel,
      exceeds200kTokens: false,
    })
  }

  return parseUserSpecifiedModel(agentModelWithExp)
}

export function getAgentModelDisplay(model: string | undefined): string {
  // When model is omitted, getDefaultSubagentModel() returns 'inherit' at runtime
  if (!model) return 'Inherit from parent (default)'
  if (model === 'inherit') return 'Inherit from parent'
  return capitalize(model)
}

/**
 * Get available model options for agents. Axiomate has no hardcoded model
 * aliases — subagents either inherit the parent model, or the user writes
 * a specific model key from ~/.axiomate.json in the agent definition.
 */
export function getAgentModelOptions(): AgentModelOption[] {
  return [
    {
      value: 'inherit',
      label: 'Inherit from parent',
      description: 'Use the same model as the main conversation',
    },
  ]
}
