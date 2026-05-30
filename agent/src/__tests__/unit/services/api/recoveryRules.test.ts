import { describe, expect, it } from 'vitest'

import type { ClassifiedError } from '../../../../services/api/errorClassifier.js'
import { decideRecovery } from '../../../../services/api/recoveryDecision.js'
import {
  RECOVERY_RULES,
  resolveRecoveryRuleDecision,
  validateRecoveryRuleCatalog,
  validateRecoveryRuleDecision,
} from '../../../../services/api/recoveryRules.js'
import type {
  RecoveryContextPatch,
  RecoveryDecision,
  RecoveryHistory,
  RecoveryObservation,
  RecoveryProtocol,
} from '../../../../services/api/recoverySession.js'
import { LLMAPIError } from '../../../../services/api/streamTypes.js'
import type { RetryContext } from '../../../../services/api/withRetry.js'

function classified(
  reason: ClassifiedError['reason'],
  overrides: Partial<ClassifiedError> = {},
): ClassifiedError {
  return {
    reason,
    statusCode: undefined,
    message: reason,
    retryable: true,
    shouldCompress: false,
    shouldFallback: false,
    retryAfterMs: undefined,
    ...overrides,
  }
}

function observe(
  reason: ClassifiedError['reason'],
  overrides: {
    protocol?: RecoveryProtocol
    classified?: Partial<ClassifiedError>
    id?: number
  } = {},
): RecoveryObservation {
  const classifiedError = classified(reason, overrides.classified)
  return {
    id: overrides.id ?? 1,
    attempt: overrides.id ?? 1,
    maxAttempts: 3,
    protocol: overrides.protocol ?? 'axiomate-generic',
    model: 'provider-main-model',
    classified: classifiedError,
    reason,
    statusCode: classifiedError.statusCode,
    retryable: classifiedError.retryable,
    shouldCompress: classifiedError.shouldCompress,
    shouldFallback: classifiedError.shouldFallback,
    message: classifiedError.message,
    previousReason: undefined,
    isFirstFailure: true,
    isFirstFailureForReason: true,
    consecutiveSameReason: 1,
  }
}

function history(
  overrides: {
    observations?: RecoveryObservation[]
    decisions?: RecoveryDecision[]
  } = {},
): RecoveryHistory {
  const observations = overrides.observations ?? []
  const decisions = overrides.decisions ?? []
  return {
    observations,
    decisions,
    previousObservation: observations.at(-2),
    previousDecision: decisions.at(-1),
    lastDecisionForReason: reason => {
      for (let i = decisions.length - 1; i >= 0; i--) {
        const decision = decisions[i]
        const observation = observations.find(
          candidate => candidate.id === decision.observationId,
        )
        if (observation?.reason === reason) {
          return decision
        }
      }
      return undefined
    },
    lastDecisionForRule: ruleId => {
      for (let i = decisions.length - 1; i >= 0; i--) {
        if (decisions[i].ruleId === ruleId) {
          return decisions[i]
        }
      }
      return undefined
    },
    hasIntent: intent =>
      decisions.some(decision => decision.intent === intent),
    countIntent: intent =>
      decisions.filter(decision => decision.intent === intent).length,
    countReason: reason =>
      observations.filter(observation => observation.reason === reason).length,
    countAction: action =>
      decisions.filter(decision => decision.action === action).length,
    countRule: ruleId =>
      decisions.filter(decision => decision.ruleId === ruleId).length,
  }
}

function context(
  retryContext: Partial<RetryContext> = {},
  error: unknown = new Error('api failure'),
  historyOverride: RecoveryHistory = history(),
) {
  return {
    canFallback: false,
    foregroundSource: true,
    recoveryBudgetExhausted: false,
    deferGeneric404StreamFallback: false,
    canUseNonStreamingFallback: false,
    canSalvageCompletedStream: false,
    willRefreshClient: false,
    retryContext: {
      model: 'provider-main-model',
      thinkingConfig: { type: 'disabled' as const },
      ...retryContext,
    },
    history: historyOverride,
    error,
    delayMsForRetryable: () => 100,
  }
}

describe('RECOVERY_RULES', () => {
  it('has a valid semantic rule catalog', () => {
    expect(() => validateRecoveryRuleCatalog()).not.toThrow()
    expect(new Set(RECOVERY_RULES.map(rule => rule.id)).size).toBe(
      RECOVERY_RULES.length,
    )
    expect(RECOVERY_RULES.every(rule => rule.protocols !== undefined)).toBe(
      true,
    )
    expect(RECOVERY_RULES.every(rule => rule.repeatPolicy !== undefined)).toBe(
      true,
    )
  })

  it('covers current semantic recovery actions and intents', () => {
    const possibleActions = RECOVERY_RULES.flatMap(rule => [...rule.actions])
    const possibleIntents = RECOVERY_RULES.map(rule => rule.intent)

    expect(possibleActions).toEqual(
      expect.arrayContaining([
        'disable_thinking',
        'drop_max_tokens',
        'omit_request_fields',
        'strip_reasoning_replay',
        'downgrade_multimodal_tool_content',
        'strip_json_schema_keywords',
        'strip_slash_enums',
        'disable_long_context_beta',
        'lower_context_tier',
        'rewrite_image_payload',
        'reduce_max_tokens',
        'retry_backoff',
      ]),
    )
    expect(possibleIntents).toEqual(
      expect.arrayContaining([
        'disable_thinking_blocks',
        'omit_oversized_token_budget',
        'omit_unsupported_request_fields',
        'remove_unverifiable_reasoning_replay',
        'downgrade_multimodal_tool_result',
        'sanitize_json_schema_for_grammar',
        'sanitize_slash_enum_schema',
        'disable_unavailable_long_context_beta',
        'lower_long_context_tier',
        'rewrite_image_payload_for_retry',
        'fit_output_budget_to_context',
        'retry_transient_failure',
      ]),
    )
  })

  it('retries Responses malformed output semantically without request mutation', () => {
    const decision = resolveRecoveryRuleDecision(
      observe('responses_null_output', { protocol: 'openai-responses' }),
      context(),
    )

    expect(decision).toMatchObject({
      intent: 'retry_transient_failure',
      action: 'retry_backoff',
      outcome: 'retrying',
      disposition: 'retry',
      repeatPolicy: 'until_reason_changes',
    })
    expect(decision?.contextPatch).toBeUndefined()
    expect(decision?.mutation).toBeUndefined()
  })

  it('delegates explicit stream-mode incompatibility to non-streaming through decision context', () => {
    const decision = decideRecovery(
      observe('streaming_unsupported', {
        protocol: 'openai-chat',
        classified: { retryable: false },
      }),
      {
        ...context(),
        canUseNonStreamingFallback: true,
      },
    )

    expect(decision).toMatchObject({
      intent: 'switch_to_non_streaming',
      action: 'non_streaming_fallback',
      outcome: 'fallback_triggered',
      disposition: 'delegate',
      repeatPolicy: 'outer_policy',
    })
  })

  it('does not use non-streaming fallback for unknown errors even when boundary flag is present', () => {
    const decision = decideRecovery(
      observe('unknown', {
        protocol: 'openai-chat',
        classified: { retryable: true },
      }),
      {
        ...context(),
        canUseNonStreamingFallback: true,
      },
    )

    expect(decision).toMatchObject({
      intent: 'retry_transient_failure',
      action: 'retry_backoff',
      outcome: 'retrying',
      disposition: 'retry',
    })
  })

  it('keeps generic stream-creation 404 fallback deferral separate from fallback execution', () => {
    const decision = decideRecovery(
      observe('unknown', {
        protocol: 'openai-chat',
        classified: { retryable: true, statusCode: 404 },
      }),
      {
        ...context(),
        deferGeneric404StreamFallback: true,
      },
    )

    expect(decision).toMatchObject({
      intent: 'switch_to_non_streaming',
      action: 'non_streaming_fallback',
      outcome: 'delegated',
      disposition: 'delegate',
      repeatPolicy: 'outer_policy',
    })
  })

  it('delegates completed Responses stream salvage through decision context', () => {
    const decision = decideRecovery(
      observe('responses_null_output', {
        protocol: 'openai-responses',
        classified: { retryable: true },
      }),
      {
        ...context(),
        canSalvageCompletedStream: true,
      },
    )

    expect(decision).toMatchObject({
      intent: 'salvage_completed_stream_output',
      action: 'salvage_stream_output',
      outcome: 'salvaged',
      disposition: 'delegate',
      repeatPolicy: 'outer_policy',
    })
  })

  it.each([
    [
      'max_tokens_too_large',
      'omit_oversized_token_budget',
      'drop_max_tokens',
      { dropMaxTokens: true },
      ['drop_max_tokens'],
    ],
    [
      'invalid_encrypted_content',
      'remove_unverifiable_reasoning_replay',
      'strip_reasoning_replay',
      { stripReasoningReplay: true },
      ['strip_reasoning_replay'],
    ],
    [
      'multimodal_tool_content_unsupported',
      'downgrade_multimodal_tool_result',
      'downgrade_multimodal_tool_content',
      { downgradeMultimodalToolContent: true },
      ['downgrade_multimodal_tool_content'],
    ],
    [
      'llama_cpp_grammar_pattern',
      'sanitize_json_schema_for_grammar',
      'strip_json_schema_keywords',
      { stripJsonSchemaKeywords: true },
      ['strip_json_schema_keywords:pattern,format'],
    ],
    [
      'slash_enum_unsupported',
      'sanitize_slash_enum_schema',
      'strip_slash_enums',
      { stripSlashEnums: true },
      ['strip_slash_enums'],
    ],
    [
      'oauth_long_context_beta_forbidden',
      'disable_unavailable_long_context_beta',
      'disable_long_context_beta',
      { disableLongContextBeta: true },
      ['disable_long_context_beta'],
    ],
  ] as const)(
    '%s produces a retry decision with context patch',
    (reason, intent, action, patch, mutation) => {
      const decision = resolveRecoveryRuleDecision(
        observe(reason),
        context(),
      )

      expect(decision).toMatchObject({
        intent,
        action,
        outcome: 'retrying',
        disposition: 'retry',
        repeatPolicy: 'once',
        contextPatch: patch,
        mutation,
      })
    },
  )

  it.each([
    ['max_tokens_too_large', { dropMaxTokens: true }],
    ['invalid_encrypted_content', { stripReasoningReplay: true }],
    [
      'multimodal_tool_content_unsupported',
      { downgradeMultimodalToolContent: true },
    ],
    ['llama_cpp_grammar_pattern', { stripJsonSchemaKeywords: true }],
    ['slash_enum_unsupported', { stripSlashEnums: true }],
    [
      'oauth_long_context_beta_forbidden',
      { disableLongContextBeta: true },
    ],
    ['image_too_large', { rewriteImagePayload: true }],
    ['long_context_tier', { lowerContextTier: true }],
  ] as const)('%s fails semantically after its one-shot key is already set', (reason, patch) => {
    const decision = resolveRecoveryRuleDecision(
      observe(reason),
      context(patch),
    )

    expect(decision).toMatchObject({
      intent: 'fail_recovery_exhausted',
      action: 'fail_fast',
      outcome: 'failing',
      disposition: 'fail',
      repeatPolicy: 'outer_policy',
    })
  })

  it('omits only newly unsupported request fields', () => {
    const decision = resolveRecoveryRuleDecision(
      observe('unsupported_parameter', {
        classified: {
          requestFieldsToOmit: ['temperature', 'stream_options'],
        },
      }),
      context({
        omittedRequestFields: ['temperature'],
      }),
    )

    expect(decision).toMatchObject({
      intent: 'omit_unsupported_request_fields',
      action: 'omit_request_fields',
      repeatPolicy: 'repeatable',
      contextPatch: {
        omittedRequestFields: ['temperature', 'stream_options'],
      },
      mutation: ['omit_request_field:stream_options'],
    })
  })

  it('retries image payload rewrite once with a recovery profile', () => {
    const decision = resolveRecoveryRuleDecision(
      observe('image_too_large', {
        classified: {
          imageRecoveryProfile: 'aggressive_size_compression',
        },
      }),
      context(),
    )

    expect(decision).toMatchObject({
      intent: 'rewrite_image_payload_for_retry',
      action: 'rewrite_image_payload',
      outcome: 'retrying',
      disposition: 'retry',
      repeatPolicy: 'once',
      contextPatch: {
        rewriteImagePayload: true,
        imageRecoveryProfile: 'aggressive_size_compression',
      },
      mutation: ['image_payload_rewrite:aggressive_size_compression'],
    })
  })

  it('delegates Anthropic long-context tier lowering before reactive compaction', () => {
    const decision = resolveRecoveryRuleDecision(
      observe('long_context_tier', {
        protocol: 'anthropic',
        classified: { shouldCompress: true, statusCode: 429 },
      }),
      context(),
    )

    expect(decision).toMatchObject({
      intent: 'lower_long_context_tier',
      action: 'lower_context_tier',
      outcome: 'delegated',
      disposition: 'delegate',
      repeatPolicy: 'delegate_once',
      contextPatch: { lowerContextTier: true },
      mutation: ['lower_context_tier'],
    })
  })

  it('reduces max tokens for parseable context-overflow details', () => {
    const decision = resolveRecoveryRuleDecision(
      observe('context_overflow'),
      context(
        {},
        new LLMAPIError(
          'input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000',
          { status: 400 },
        ),
      ),
    )

    expect(decision).toMatchObject({
      intent: 'fit_output_budget_to_context',
      action: 'reduce_max_tokens',
      outcome: 'retrying',
      disposition: 'retry',
      repeatPolicy: 'until_reason_changes',
      contextPatch: { maxTokensOverride: 10941 } satisfies RecoveryContextPatch,
      mutation: ['max_tokens=10941'],
    })
  })

  it('validates dynamic decisions against their owning rule', () => {
    const rule = RECOVERY_RULES.find(
      candidate => candidate.id === 'drop-overlarge-max-tokens',
    )!
    const observation = observe('max_tokens_too_large')

    expect(() =>
      validateRecoveryRuleDecision(rule, {
        observationId: observation.id,
        ruleId: rule.id,
        repeatPolicy: rule.repeatPolicy,
        intent: 'fail_recovery_exhausted',
        action: 'drop_max_tokens',
        outcome: 'retrying',
        disposition: 'retry',
      }),
    ).toThrow(/intent/)
  })
})
