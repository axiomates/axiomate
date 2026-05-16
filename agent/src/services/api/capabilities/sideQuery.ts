/**
 * Side query — lightweight non-streaming inference for classifiers, explainers, validation.
 *
 * Routes to provider-specific implementation based on provider.name.
 * Each provider handles its own system prompt conventions, attribution, betas, etc.
 */
import type { LLMProvider } from '../provider.js'
import type {
  ContentBlockParam,
  InferenceResponse,
  MessageParam,
  NeutralOutputFormat,
  NeutralToolSchema,
  ToolChoice,
} from '../streamTypes.js'
import type { QuerySource } from '../../../constants/querySource.js'
import { anthropicSideQuery } from './anthropic/sideQuery.js'

/**
 * Protocol-neutral side query options.
 * No SDK types — all fields are neutral or primitive.
 */
export type NeutralSideQueryOptions = {
  model: string
  system?: string | ContentBlockParam[]
  messages: MessageParam[]
  tools?: NeutralToolSchema[]
  toolChoice?: ToolChoice
  outputFormat?: NeutralOutputFormat
  maxTokens?: number
  maxRetries?: number
  signal?: AbortSignal
  skipSystemPromptPrefix?: boolean
  temperature?: number
  /** Thinking budget (enables thinking), or `false` to send `{ type: 'disabled' }`. */
  thinking?: number | false
  stopSequences?: string[]
  querySource: QuerySource
}

/**
 * Execute a side query through the appropriate provider.
 * Routes based on provider.name.
 */
export async function sideQuery(
  provider: LLMProvider,
  options: NeutralSideQueryOptions,
): Promise<InferenceResponse> {
  switch (provider.name) {
    case 'anthropic':
      return anthropicSideQuery(provider, options)
    case 'openai-chat':
    case 'openai-responses':
      // Both OpenAI-family providers expose the same neutral inference()
      // contract; no provider-specific wrapping needed.
      return provider.inference({
        model: options.model,
        messages: options.messages,
        system: options.system,
        tools: options.tools,
        toolChoice: options.toolChoice,
        outputFormat: options.outputFormat,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        thinking: options.thinking === false
          ? { type: 'disabled' }
          : options.thinking
            ? { type: 'enabled', budgetTokens: options.thinking }
            : undefined,
        stopSequences: options.stopSequences,
        signal: options.signal,
      })
    default:
      throw new Error(`sideQuery: unsupported provider '${provider.name}'`)
  }
}
