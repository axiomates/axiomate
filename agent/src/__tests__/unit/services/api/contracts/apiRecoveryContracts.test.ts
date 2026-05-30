import { describe, expect, it } from 'vitest'

import {
  classifyError,
  type ClassifiedError,
  type ErrorClassificationContext,
} from '../../../../../services/api/errorClassifier.js'
import { resolveRecoveryAction } from '../../../../../services/api/recoveryAction.js'
import { LLMAPIError } from '../../../../../services/api/streamTypes.js'

type ContractCase = {
  name: string
  protocol: ErrorClassificationContext['provider']
  error: unknown
  expectedReason: ClassifiedError['reason']
  expectedAction: ReturnType<typeof resolveRecoveryAction>
  context?: Partial<ErrorClassificationContext>
}

class RateLimitError extends Error {}

const cases: ContractCase[] = [
  {
    name: 'OpenAI Chat: 400 unsupported temperature can omit field',
    protocol: 'openai-chat',
    error: new LLMAPIError('Unsupported parameter: temperature', {
      status: 400,
      error: { error: { code: 'unsupported_parameter', param: 'temperature' } },
    }),
    expectedReason: 'unsupported_parameter',
    expectedAction: 'omit_request_fields',
  },
  {
    name: 'OpenAI Chat: 502 request validation is not server retry',
    protocol: 'openai-chat',
    error: new LLMAPIError('Bad Gateway: unknown parameter stream_options', {
      status: 502,
      error: { error: { code: 'unknown_parameter', param: 'stream_options' } },
    }),
    expectedReason: 'unsupported_parameter',
    expectedAction: 'omit_request_fields',
  },
  {
    name: 'OpenAI Chat: generic 404 is retryable unknown, not model fallback',
    protocol: 'openai-chat',
    error: new LLMAPIError('Not Found', { status: 404 }),
    expectedReason: 'unknown',
    expectedAction: 'retry_backoff',
  },
  {
    name: 'OpenAI-compatible: message-only payload-too-large compresses',
    protocol: 'openai-chat',
    error: new Error('Request failed with error code: 413'),
    expectedReason: 'payload_too_large',
    expectedAction: 'request_compaction',
  },
  {
    name: 'OpenAI-compatible: SDK RateLimitError without status is semantic',
    protocol: 'openai-chat',
    error: new RateLimitError('Provider rejected request'),
    expectedReason: 'rate_limit',
    expectedAction: 'retry_backoff',
  },
  {
    name: 'OpenAI Responses: invalid encrypted reasoning replay strips replay',
    protocol: 'openai-responses',
    error: new LLMAPIError(
      'Encrypted content for item rs_123 could not be verified',
      {
        status: 400,
        error: { error: { code: 'invalid_encrypted_content' } },
      },
    ),
    expectedReason: 'invalid_encrypted_content',
    expectedAction: 'strip_reasoning_replay',
  },
  {
    name: 'OpenAI Responses: terminal output=null parser error is semantic',
    protocol: 'openai-responses',
    error: new TypeError("'NoneType' object is not iterable"),
    expectedReason: 'responses_null_output',
    expectedAction: 'retry_backoff',
  },
  {
    name: 'OpenAI Responses: empty non-streaming output is malformed response',
    protocol: 'openai-responses',
    error: new LLMAPIError('Responses API returned empty content', {
      status: 502,
    }),
    expectedReason: 'malformed_response',
    expectedAction: 'retry_backoff',
  },
  {
    name: 'OpenAI Responses Grok: invalid arguments can strip slash enums',
    protocol: 'openai-responses',
    error: new LLMAPIError('Invalid arguments passed to the model', {
      status: 400,
    }),
    expectedReason: 'slash_enum_unsupported',
    expectedAction: 'strip_slash_enums',
    context: { model: 'grok-4.3' },
  },
  {
    name: 'OpenAI-compatible: multimodal tool output can downgrade',
    protocol: 'openai-chat',
    error: new LLMAPIError('tool message content must be a string', {
      status: 400,
    }),
    expectedReason: 'multimodal_tool_content_unsupported',
    expectedAction: 'downgrade_multimodal_tool_content',
  },
  {
    name: 'OpenAI-compatible local: llama.cpp grammar strips schema keywords',
    protocol: 'openai-chat',
    error: new LLMAPIError('error parsing grammar: json-schema-to-grammar', {
      status: 400,
    }),
    expectedReason: 'llama_cpp_grammar_pattern',
    expectedAction: 'strip_json_schema_keywords',
  },
  {
    name: 'Anthropic: long-context tier delegates to tier lowering',
    protocol: 'anthropic',
    error: new LLMAPIError(
      'Rate limited: extra usage tier required for long context requests',
      { status: 429 },
    ),
    expectedReason: 'long_context_tier',
    expectedAction: 'lower_context_tier',
  },
  {
    name: 'Anthropic: OAuth long-context beta can be disabled once',
    protocol: 'anthropic',
    error: new LLMAPIError(
      'The long context beta is not yet available for this subscription.',
      { status: 400 },
    ),
    expectedReason: 'oauth_long_context_beta_forbidden',
    expectedAction: 'disable_long_context_beta',
  },
  {
    name: 'Anthropic: image size rewrites retry-local image payload',
    protocol: 'anthropic',
    error: new LLMAPIError('image exceeds 5 MB maximum', { status: 400 }),
    expectedReason: 'image_too_large',
    expectedAction: 'rewrite_image_payload',
  },
  {
    name: 'OpenRouter: policy block fails fast without fallback',
    protocol: 'openai-chat',
    error: new LLMAPIError(
      'No endpoints available matching your guardrail restrictions and data policy.',
      { status: 400 },
    ),
    expectedReason: 'provider_policy_blocked',
    expectedAction: 'fail_fast',
  },
  {
    name: 'Provider safety filter: content policy block is deterministic',
    protocol: 'openai-chat',
    error: new LLMAPIError('The prompt was flagged by our safety system.', {
      status: 400,
    }),
    expectedReason: 'content_policy_blocked',
    expectedAction: 'fail_fast',
  },
  {
    name: 'Transport: SSL alert remains timeout even on large session',
    protocol: 'anthropic',
    error: new Error('SSL alert bad record mac'),
    expectedReason: 'timeout',
    expectedAction: 'retry_backoff',
    context: { approxTokens: 160_000, contextLength: 200_000 },
  },
]

describe('API recovery contracts', () => {
  it.each(cases)('$name', contract => {
    const classified = classifyError(contract.error, {
      provider: contract.protocol,
      model: 'provider-main-model',
      ...contract.context,
    })

    expect(classified.reason).toBe(contract.expectedReason)
    expect(resolveRecoveryAction(classified)).toBe(contract.expectedAction)
  })
})
