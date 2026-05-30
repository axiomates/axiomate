import { logError } from '../../utils/log.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import type {
  ClassifiedError,
  ErrorFailoverReason,
} from './errorClassifier.js'
import {
  DEFAULT_IMAGE_RECOVERY_PROFILE,
  type ImageRecoveryProfile,
} from './imageRecovery.js'
import type { ModelFallbackAvailability } from './recoveryFallback.js'
import type { RecoveryAction } from './recoveryAction.js'
import type { RecoveryIntent } from './recoveryIntent.js'
import { RECOVERY_PROTOCOLS } from './recoverySession.js'
import type {
  RecoveryContextPatch,
  RecoveryDecision,
  RecoveryDecisionDisposition,
  RecoveryHistory,
  RecoveryObservation,
  RecoveryProtocol,
  RecoveryRuleRepeatPolicy,
} from './recoverySession.js'
import type { RecoveryDecisionOutcome } from './recoveryTrace.js'
import { LLMAPIError } from './streamTypes.js'

const FLOOR_OUTPUT_TOKENS = 3000

type RetryContextState = {
  maxTokensOverride?: number
  dropMaxTokens?: boolean
  omittedRequestFields?: string[]
  stripReasoningReplay?: boolean
  downgradeMultimodalToolContent?: boolean
  stripJsonSchemaKeywords?: boolean
  stripSlashEnums?: boolean
  disableLongContextBeta?: boolean
  lowerContextTier?: boolean
  rewriteImagePayload?: boolean
  imageRecoveryProfile?: ImageRecoveryProfile
  thinkingConfig: { type: ThinkingConfig['type'] }
}

export interface RecoveryDecisionContext {
  fallbackAvailability?: ModelFallbackAvailability
  /**
   * Legacy compatibility for direct unit tests and boundary callers that do not
   * have a model candidate. New retry paths must pass `fallbackAvailability`
   * so candidate, policy, and denial reason stay explicit.
   */
  canFallback?: boolean
  foregroundSource: boolean
  recoveryBudgetExhausted: boolean
  deferGeneric404StreamFallback: boolean
  canUseNonStreamingFallback?: boolean
  canSalvageCompletedStream?: boolean
  willRefreshClient: boolean
  retryContext: RetryContextState
  history: RecoveryHistory
  error: unknown
  delayMsForRetryable: () => number
}

type RuleInput = {
  rule: RecoveryRule
  observation: RecoveryObservation
  context: RecoveryDecisionContext
}

type PatchBuilder = (input: RuleInput) => RecoveryContextPatch | undefined
type MutationBuilder = (input: RuleInput) => string[] | undefined
type Precondition = (input: RuleInput) => boolean
type RuleDecisionBuilder = (input: RuleInput) => RecoveryDecision | undefined
type NoDecisionBehavior = 'continue' | 'fail_recovery_exhausted'

export type RecoveryRuleContextKey =
  | 'dropMaxTokens'
  | 'stripReasoningReplay'
  | 'downgradeMultimodalToolContent'
  | 'stripJsonSchemaKeywords'
  | 'stripSlashEnums'
  | 'disableLongContextBeta'
  | 'lowerContextTier'
  | 'rewriteImagePayload'

export interface RecoveryRule {
  id: string
  reasons: readonly ErrorFailoverReason[]
  protocols: readonly RecoveryProtocol[] | 'any'
  intent: RecoveryIntent
  actions: readonly RecoveryAction[]
  outcome: RecoveryDecisionOutcome
  disposition: RecoveryDecisionDisposition
  repeatPolicy: RecoveryRuleRepeatPolicy
  contextKey?: RecoveryRuleContextKey
  contextPatch?: RecoveryContextPatch | PatchBuilder
  mutation?: readonly string[] | MutationBuilder
  precondition?: Precondition
  onPreconditionFailed?: NoDecisionBehavior
  onNoDecision?: NoDecisionBehavior
  decide?: RuleDecisionBuilder
}

type BuiltDecisionOptions = Omit<
  RecoveryDecision,
  | 'observationId'
  | 'intent'
  | 'action'
  | 'outcome'
  | 'disposition'
  | 'ruleId'
  | 'repeatPolicy'
>

export const RECOVERY_RULES: readonly RecoveryRule[] = [
  {
    id: 'thinking-signature-disable-thinking',
    reasons: ['thinking_signature'],
    protocols: ['anthropic', 'axiomate-generic'],
    intent: 'disable_thinking_blocks',
    actions: ['disable_thinking'],
    outcome: 'retrying',
    disposition: 'retry',
    repeatPolicy: 'once',
    precondition: ({ context }) =>
      context.retryContext.thinkingConfig.type !== 'disabled',
    onPreconditionFailed: 'fail_recovery_exhausted',
    contextPatch: { thinkingConfig: { type: 'disabled' } },
    mutation: ['thinking_config=disabled'],
  },
  {
    id: 'drop-overlarge-max-tokens',
    reasons: ['max_tokens_too_large'],
    protocols: ['openai-chat', 'openai-responses', 'axiomate-generic'],
    intent: 'omit_oversized_token_budget',
    actions: ['drop_max_tokens'],
    outcome: 'retrying',
    disposition: 'retry',
    repeatPolicy: 'once',
    contextKey: 'dropMaxTokens',
    contextPatch: { dropMaxTokens: true },
    mutation: ['drop_max_tokens'],
  },
  {
    id: 'omit-unsupported-request-fields',
    reasons: ['unsupported_parameter'],
    protocols: 'any',
    intent: 'omit_unsupported_request_fields',
    actions: ['omit_request_fields'],
    outcome: 'retrying',
    disposition: 'retry',
    repeatPolicy: 'repeatable',
    decide: ({ rule, observation, context }) => {
      const newFields = (
        observation.classified.requestFieldsToOmit ?? []
      ).filter(
        field => !context.retryContext.omittedRequestFields?.includes(field),
      )
      if (newFields.length === 0) {
        return undefined
      }
      return ruleDecision(rule, observation, {
        contextPatch: {
          omittedRequestFields: [
            ...(context.retryContext.omittedRequestFields ?? []),
            ...newFields,
          ],
        },
        mutation: newFields.map(field => `omit_request_field:${field}`),
      })
    },
  },
  {
    id: 'strip-invalid-encrypted-responses-replay',
    reasons: ['invalid_encrypted_content'],
    protocols: ['openai-responses', 'axiomate-generic'],
    intent: 'remove_unverifiable_reasoning_replay',
    actions: ['strip_reasoning_replay'],
    outcome: 'retrying',
    disposition: 'retry',
    repeatPolicy: 'once',
    contextKey: 'stripReasoningReplay',
    contextPatch: { stripReasoningReplay: true },
    mutation: ['strip_reasoning_replay'],
  },
  {
    id: 'retry-malformed-responses-output',
    reasons: ['responses_null_output', 'malformed_response'],
    protocols: ['openai-chat', 'openai-responses', 'anthropic', 'axiomate-generic'],
    intent: 'retry_transient_failure',
    actions: ['retry_backoff'],
    outcome: 'retrying',
    disposition: 'retry',
    repeatPolicy: 'until_reason_changes',
    onNoDecision: 'continue',
  },
  {
    id: 'downgrade-multimodal-tool-result-content',
    reasons: ['multimodal_tool_content_unsupported'],
    protocols: 'any',
    intent: 'downgrade_multimodal_tool_result',
    actions: ['downgrade_multimodal_tool_content'],
    outcome: 'retrying',
    disposition: 'retry',
    repeatPolicy: 'once',
    contextKey: 'downgradeMultimodalToolContent',
    contextPatch: { downgradeMultimodalToolContent: true },
    mutation: ['downgrade_multimodal_tool_content'],
  },
  {
    id: 'strip-llama-cpp-schema-keywords',
    reasons: ['llama_cpp_grammar_pattern'],
    protocols: ['openai-chat', 'openai-responses', 'axiomate-generic'],
    intent: 'sanitize_json_schema_for_grammar',
    actions: ['strip_json_schema_keywords'],
    outcome: 'retrying',
    disposition: 'retry',
    repeatPolicy: 'once',
    contextKey: 'stripJsonSchemaKeywords',
    contextPatch: { stripJsonSchemaKeywords: true },
    mutation: ['strip_json_schema_keywords:pattern,format'],
  },
  {
    id: 'strip-grok-slash-enums',
    reasons: ['slash_enum_unsupported'],
    protocols: ['openai-responses', 'axiomate-generic'],
    intent: 'sanitize_slash_enum_schema',
    actions: ['strip_slash_enums'],
    outcome: 'retrying',
    disposition: 'retry',
    repeatPolicy: 'once',
    contextKey: 'stripSlashEnums',
    contextPatch: { stripSlashEnums: true },
    mutation: ['strip_slash_enums'],
  },
  {
    id: 'disable-oauth-long-context-beta',
    reasons: ['oauth_long_context_beta_forbidden'],
    protocols: ['anthropic', 'axiomate-generic'],
    intent: 'disable_unavailable_long_context_beta',
    actions: ['disable_long_context_beta'],
    outcome: 'retrying',
    disposition: 'retry',
    repeatPolicy: 'once',
    contextKey: 'disableLongContextBeta',
    contextPatch: { disableLongContextBeta: true },
    mutation: ['disable_long_context_beta'],
  },
  {
    id: 'delegate-image-payload-shrink',
    reasons: ['image_too_large'],
    protocols: 'any',
    intent: 'rewrite_image_payload_for_retry',
    actions: ['rewrite_image_payload'],
    outcome: 'retrying',
    disposition: 'retry',
    repeatPolicy: 'once',
    contextKey: 'rewriteImagePayload',
    contextPatch: ({ observation }) => ({
      rewriteImagePayload: true,
      imageRecoveryProfile:
        observation.classified.imageRecoveryProfile ??
        DEFAULT_IMAGE_RECOVERY_PROFILE,
    }),
    mutation: ({ observation }) => [
      `image_payload_rewrite:${observation.classified.imageRecoveryProfile ?? DEFAULT_IMAGE_RECOVERY_PROFILE}`,
    ],
  },
  {
    id: 'anthropic-lower-long-context-tier',
    reasons: ['long_context_tier'],
    protocols: ['anthropic', 'axiomate-generic'],
    intent: 'lower_long_context_tier',
    actions: ['lower_context_tier'],
    outcome: 'delegated',
    disposition: 'delegate',
    repeatPolicy: 'delegate_once',
    contextKey: 'lowerContextTier',
    contextPatch: { lowerContextTier: true },
    mutation: ['lower_context_tier'],
  },
  {
    id: 'context-overflow-disable-thinking',
    reasons: ['context_overflow'],
    protocols: 'any',
    intent: 'disable_thinking_blocks',
    actions: ['disable_thinking'],
    outcome: 'retrying',
    disposition: 'retry',
    repeatPolicy: 'once',
    precondition: ({ context }) =>
      context.retryContext.thinkingConfig.type !== 'disabled',
    onPreconditionFailed: 'continue',
    contextPatch: { thinkingConfig: { type: 'disabled' } },
    mutation: ['thinking_config=disabled'],
  },
  {
    id: 'context-overflow-fit-output-budget',
    reasons: ['context_overflow'],
    protocols: 'any',
    intent: 'fit_output_budget_to_context',
    actions: ['reduce_max_tokens'],
    outcome: 'retrying',
    disposition: 'retry',
    repeatPolicy: 'until_reason_changes',
    onNoDecision: 'continue',
    decide: ({ rule, observation, context }) => {
      if (!(context.error instanceof LLMAPIError)) {
        return undefined
      }
      const overflowData = parseMaxTokensContextOverflowError(context.error)
      if (!overflowData) {
        return undefined
      }

      const adjustedMaxTokens = getContextOverflowMaxTokens(overflowData)
      if (adjustedMaxTokens === undefined) {
        return undefined
      }

      if (context.retryContext.maxTokensOverride === adjustedMaxTokens) {
        return undefined
      }

      return ruleDecision(rule, observation, {
        contextPatch: { maxTokensOverride: adjustedMaxTokens },
        mutation: [`max_tokens=${adjustedMaxTokens}`],
      })
    },
  },
]

export function resolveRecoveryRuleDecision(
  observation: RecoveryObservation,
  context: RecoveryDecisionContext,
): RecoveryDecision | undefined {
  for (const rule of RECOVERY_RULES) {
    if (!matchesRule(rule, observation)) {
      continue
    }

    const input = { rule, observation, context }
    if (rule.precondition && !rule.precondition(input)) {
      if (rule.onPreconditionFailed === 'fail_recovery_exhausted') {
        return buildRuleExhaustedDecision(observation)
      }
      continue
    }
    if (isRepeatPolicyExhausted(rule, observation, context)) {
      return buildRuleExhaustedDecision(observation)
    }

    const decision = rule.decide
      ? rule.decide(input)
      : ruleDecision(rule, observation, {
          contextPatch: resolvePatch(rule, input),
          mutation: resolveMutation(rule, input),
        })

    if (!decision) {
      if ((rule.onNoDecision ?? 'fail_recovery_exhausted') === 'continue') {
        continue
      }
      return buildRuleExhaustedDecision(observation)
    }

    validateRecoveryRuleDecision(rule, decision)
    return decision
  }

  return undefined
}

export function validateRecoveryRuleCatalog(
  rules: readonly RecoveryRule[] = RECOVERY_RULES,
): void {
  const ids = new Set<string>()
  for (const rule of rules) {
    if (ids.has(rule.id)) {
      throw new Error(`Duplicate recovery rule id: ${rule.id}`)
    }
    ids.add(rule.id)

    if (rule.reasons.length === 0) {
      throw new Error(`Recovery rule ${rule.id} must declare at least one reason`)
    }
    if (rule.actions.length === 0) {
      throw new Error(`Recovery rule ${rule.id} must declare at least one action`)
    }
    if (rule.protocols !== 'any' && rule.protocols.length === 0) {
      throw new Error(`Recovery rule ${rule.id} has an empty protocols list`)
    }
    if (
      rule.protocols !== 'any' &&
      rule.protocols.some(protocol => !RECOVERY_PROTOCOLS.includes(protocol))
    ) {
      throw new Error(`Recovery rule ${rule.id} has an unknown protocol`)
    }
    if (
      rule.contextKey &&
      (rule.repeatPolicy !== 'once' && rule.repeatPolicy !== 'delegate_once')
    ) {
      throw new Error(
        `Recovery rule ${rule.id} uses contextKey but is not one-shot`,
      )
    }
  }
}

export function validateRecoveryRuleDecision(
  rule: RecoveryRule,
  decision: RecoveryDecision,
): void {
  if (decision.ruleId !== rule.id) {
    throw new Error(
      `Recovery rule ${rule.id} returned decision for ${decision.ruleId ?? 'no rule'}`,
    )
  }
  if (decision.repeatPolicy !== rule.repeatPolicy) {
    throw new Error(
      `Recovery rule ${rule.id} returned repeat policy ${decision.repeatPolicy ?? 'none'}`,
    )
  }
  if (decision.intent !== rule.intent) {
    throw new Error(
      `Recovery rule ${rule.id} returned intent ${decision.intent}, expected ${rule.intent}`,
    )
  }
  if (!rule.actions.includes(decision.action)) {
    throw new Error(
      `Recovery rule ${rule.id} returned unsupported action ${decision.action}`,
    )
  }
}

function matchesRule(
  rule: RecoveryRule,
  observation: RecoveryObservation,
): boolean {
  return (
    rule.reasons.includes(observation.reason) &&
    (rule.protocols === 'any' ||
      rule.protocols.includes(observation.protocol))
  )
}

function isRepeatPolicyExhausted(
  rule: RecoveryRule,
  observation: RecoveryObservation,
  context: RecoveryDecisionContext,
): boolean {
  if (rule.contextKey && context.retryContext[rule.contextKey]) {
    return true
  }

  switch (rule.repeatPolicy) {
    case 'repeatable':
      return false
    case 'once':
    case 'delegate_once':
      return context.history.countRule(rule.id) > 0
    case 'until_reason_changes': {
      const lastDecision = context.history.lastDecisionForRule(rule.id)
      if (!lastDecision) {
        return false
      }
      const lastObservation = context.history.observations.find(
        candidate => candidate.id === lastDecision.observationId,
      )
      return lastObservation?.reason === observation.reason
    }
  }
}

function resolvePatch(
  rule: RecoveryRule,
  input: RuleInput,
): RecoveryContextPatch | undefined {
  if (typeof rule.contextPatch === 'function') {
    return rule.contextPatch(input)
  }
  return rule.contextPatch
}

function resolveMutation(
  rule: RecoveryRule,
  input: RuleInput,
): string[] | undefined {
  if (typeof rule.mutation === 'function') {
    return rule.mutation(input)
  }
  return rule.mutation ? [...rule.mutation] : undefined
}

function ruleDecision(
  rule: RecoveryRule,
  observation: RecoveryObservation,
  extras: BuiltDecisionOptions = {},
): RecoveryDecision {
  return {
    observationId: observation.id,
    intent: rule.intent,
    action: rule.actions[0],
    outcome: rule.outcome,
    disposition: rule.disposition,
    ruleId: rule.id,
    repeatPolicy: rule.repeatPolicy,
    ...extras,
  }
}

function buildRuleExhaustedDecision(
  observation: RecoveryObservation,
): RecoveryDecision {
  return buildOuterPolicyDecision(
    observation,
    'fail_recovery_exhausted',
    'fail_fast',
    'failing',
    'fail',
  )
}

export function buildOuterPolicyDecision(
  observation: RecoveryObservation,
  intent: RecoveryIntent,
  action: RecoveryAction,
  outcome: RecoveryDecisionOutcome,
  disposition: RecoveryDecisionDisposition,
  extras: Omit<
    RecoveryDecision,
    | 'observationId'
    | 'intent'
    | 'action'
    | 'outcome'
    | 'disposition'
    | 'ruleId'
    | 'repeatPolicy'
  > = {},
): RecoveryDecision {
  return {
    observationId: observation.id,
    intent,
    action,
    outcome,
    disposition,
    repeatPolicy: 'outer_policy',
    ...extras,
  }
}

function getContextOverflowMaxTokens(
  overflowData: {
    inputTokens: number
    contextLimit: number
  },
): number | undefined {
  const { inputTokens, contextLimit } = overflowData
  const safetyBuffer = 1000
  const availableContext = Math.max(
    0,
    contextLimit - inputTokens - safetyBuffer,
  )
  if (availableContext < FLOOR_OUTPUT_TOKENS) {
    logError(
      new Error(
        `availableContext ${availableContext} is less than FLOOR_OUTPUT_TOKENS ${FLOOR_OUTPUT_TOKENS}`,
      ),
    )
    return undefined
  }
  return Math.max(FLOOR_OUTPUT_TOKENS, availableContext)
}

export function parseMaxTokensContextOverflowError(error: LLMAPIError):
  | {
      inputTokens: number
      maxTokens: number
      contextLimit: number
    }
  | undefined {
  if (error.status !== 400 || !error.message) {
    return undefined
  }

  if (
    !error.message.includes(
      'input length and `max_tokens` exceed context limit',
    )
  ) {
    return undefined
  }

  const regex =
    /input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)/
  const match = error.message.match(regex)

  if (!match || match.length !== 4) {
    return undefined
  }

  if (!match[1] || !match[2] || !match[3]) {
    logError(
      new Error(
        'Unable to parse max_tokens from max_tokens exceed context limit error message',
      ),
    )
    return undefined
  }
  const inputTokens = parseInt(match[1], 10)
  const maxTokens = parseInt(match[2], 10)
  const contextLimit = parseInt(match[3], 10)

  if (isNaN(inputTokens) || isNaN(maxTokens) || isNaN(contextLimit)) {
    return undefined
  }

  return { inputTokens, maxTokens, contextLimit }
}
