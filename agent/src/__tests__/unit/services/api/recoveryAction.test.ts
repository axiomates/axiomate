import { describe, expect, it } from 'vitest'

import type { ClassifiedError } from '../../../../services/api/errorClassifier.js'
import { resolveRecoveryAction } from '../../../../services/api/recoveryAction.js'

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

describe('resolveRecoveryAction', () => {
  it('maps abort to abort', () => {
    expect(
      resolveRecoveryAction(classified('abort', { retryable: false })),
    ).toBe('abort')
  })

  it('maps non-retryable fallback hints to fallback_model when available', () => {
    expect(
      resolveRecoveryAction(
        classified('model_not_found', {
          retryable: false,
          shouldFallback: true,
        }),
        { canFallback: true },
      ),
    ).toBe('fallback_model')
  })

  it('does not claim fallback_model when no distinct fallback is available', () => {
    expect(
      resolveRecoveryAction(
        classified('model_not_found', {
          retryable: false,
          shouldFallback: true,
        }),
      ),
    ).toBe('fail_fast')
  })

  it('maps content policy blocks to fallback only when a candidate is available', () => {
    const error = classified('content_policy_blocked', {
      retryable: false,
      shouldFallback: true,
    })

    expect(resolveRecoveryAction(error)).toBe('fail_fast')
    expect(resolveRecoveryAction(error, { canFallback: true })).toBe(
      'fallback_model',
    )
  })

  it('maps thinking signature errors to disable_thinking', () => {
    expect(resolveRecoveryAction(classified('thinking_signature'))).toBe(
      'disable_thinking',
    )
  })

  it('maps max_tokens_too_large to drop_max_tokens', () => {
    expect(resolveRecoveryAction(classified('max_tokens_too_large'))).toBe(
      'drop_max_tokens',
    )
  })

  it('maps unsupported parameters with fields to omit_request_fields', () => {
    expect(
      resolveRecoveryAction(
        classified('unsupported_parameter', {
          requestFieldsToOmit: ['temperature'],
        }),
      ),
    ).toBe('omit_request_fields')
  })

  it('maps invalid encrypted content to strip_reasoning_replay', () => {
    expect(resolveRecoveryAction(classified('invalid_encrypted_content'))).toBe(
      'strip_reasoning_replay',
    )
  })

  it('maps Responses null output to retry_backoff outside stream salvage', () => {
    expect(resolveRecoveryAction(classified('responses_null_output'))).toBe(
      'retry_backoff',
    )
  })

  it('maps multimodal tool content rejection to downgrade_multimodal_tool_content', () => {
    expect(
      resolveRecoveryAction(
        classified('multimodal_tool_content_unsupported'),
      ),
    ).toBe('downgrade_multimodal_tool_content')
  })

  it('maps llama.cpp grammar failures to strip_json_schema_keywords', () => {
    expect(resolveRecoveryAction(classified('llama_cpp_grammar_pattern'))).toBe(
      'strip_json_schema_keywords',
    )
  })

  it('maps Grok slash-enum failures to strip_slash_enums', () => {
    expect(resolveRecoveryAction(classified('slash_enum_unsupported'))).toBe(
      'strip_slash_enums',
    )
  })

  it('maps OAuth long-context beta rejection to disable_long_context_beta', () => {
    expect(
      resolveRecoveryAction(classified('oauth_long_context_beta_forbidden')),
    ).toBe('disable_long_context_beta')
  })

  it('maps image-too-large to rewrite_image_payload', () => {
    expect(resolveRecoveryAction(classified('image_too_large'))).toBe(
      'rewrite_image_payload',
    )
  })

  it('maps Anthropic long-context tier gates to lower_context_tier', () => {
    expect(
      resolveRecoveryAction(
        classified('long_context_tier', { shouldCompress: true }),
      ),
    ).toBe('lower_context_tier')
  })

  it.each([
    'context_overflow',
    'payload_too_large',
  ] as const)('maps %s to request_compaction', reason => {
    expect(
      resolveRecoveryAction(
        classified(reason, {
          shouldCompress: true,
        }),
      ),
    ).toBe('request_compaction')
  })

  it('maps refreshable connection errors to refresh_client', () => {
    expect(
      resolveRecoveryAction(classified('connection'), {
        willRefreshClient: true,
      }),
    ).toBe('refresh_client')
  })

  it('maps retry-after rate limits to retry_after', () => {
    expect(
      resolveRecoveryAction(
        classified('rate_limit', {
          retryAfterMs: 10_000,
        }),
      ),
    ).toBe('retry_after')
  })

  it('maps retryable errors to retry_backoff by default', () => {
    expect(resolveRecoveryAction(classified('server_error'))).toBe(
      'retry_backoff',
    )
  })

  it('maps exhausted retryable fallback hints to fallback_model', () => {
    expect(
      resolveRecoveryAction(
        classified('rate_limit', {
          retryable: true,
          shouldFallback: true,
        }),
        { canFallback: true, recoveryBudgetExhausted: true },
      ),
    ).toBe('fallback_model')
  })
})
