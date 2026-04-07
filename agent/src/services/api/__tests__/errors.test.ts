import { describe, it, expect, vi } from 'vitest'
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from '@anthropic-ai/sdk'

// ── Mocks for transitive dependencies ────────────────────────────────

vi.mock('../../../services/analytics/index.js', () => ({
  logEvent: vi.fn(),
}))

vi.mock('../../../bootstrap/state.js', () => ({
  getIsNonInteractiveSession: vi.fn().mockReturnValue(false),
}))

vi.mock('../../../utils/auth.js', () => ({
  isClaudeAISubscriber: vi.fn().mockReturnValue(false),
  isMaxSubscriber: vi.fn().mockReturnValue(false),
  isTeamPremiumSubscriber: vi.fn().mockReturnValue(false),
  isEnterpriseSubscriber: vi.fn().mockReturnValue(false),
  getAnthropicApiKeyWithSource: vi.fn().mockReturnValue({ source: '' }),
  getClaudeAIOAuthTokens: vi.fn().mockReturnValue(null),
  getOauthAccountInfo: vi.fn().mockReturnValue(null),
}))

vi.mock('../../../utils/messages.js', () => ({
  createAssistantAPIErrorMessage: vi.fn((_opts: unknown) => ({})),
  NO_RESPONSE_REQUESTED: '__NO_RESPONSE__',
}))

vi.mock('../../../utils/model/model.js', () => ({
  getDefaultMainLoopModelSetting: vi.fn().mockReturnValue('claude-sonnet-4-20250514'),
  isNonCustomOpusModel: vi.fn().mockReturnValue(false),
}))

vi.mock('../../../utils/model/modelStrings.js', () => ({
  getModelStrings: vi.fn().mockReturnValue({
    opus41: 'claude-opus-4-20250115',
    sonnet45: 'claude-sonnet-4-5-20250115',
    sonnet40: 'claude-sonnet-4-20250514',
  }),
}))

vi.mock('../../../utils/model/providers.js', () => ({
  getAPIProvider: vi.fn().mockReturnValue('firstParty'),
}))

vi.mock('../../../constants/betas.js', () => ({
  AFK_MODE_BETA_HEADER: '',
}))

vi.mock('../../../constants/apiLimits.js', () => ({
  API_PDF_MAX_PAGES: 100,
  PDF_TARGET_RAW_SIZE: 32 * 1024 * 1024,
}))

vi.mock('../../../utils/envUtils.js', () => ({
  isEnvTruthy: vi.fn().mockReturnValue(false),
}))

vi.mock('../../../utils/format.js', () => ({
  formatFileSize: vi.fn().mockReturnValue('32 MB'),
}))

vi.mock('../../../utils/imageResizer.js', () => ({
  ImageResizeError: class ImageResizeError extends Error {
    constructor(msg: string) { super(msg); this.name = 'ImageResizeError' }
  },
}))

vi.mock('../../../utils/imageValidation.js', () => ({
  ImageSizeError: class ImageSizeError extends Error {
    constructor(msg: string) { super(msg); this.name = 'ImageSizeError' }
  },
}))

vi.mock('../../../utils/privacyLevel.js', () => ({
  isEssentialTrafficOnly: vi.fn().mockReturnValue(false),
}))

vi.mock('../../apiLimits.js', () => ({
  getRateLimitErrorMessage: vi.fn().mockReturnValue(null),
}))

vi.mock('../../rateLimitMocking.js', () => ({
  shouldProcessRateLimits: vi.fn().mockReturnValue(false),
}))

vi.mock('../errorUtils.js', () => ({
  extractConnectionErrorDetails: vi.fn().mockReturnValue(null),
  formatAPIError: vi.fn((e: { message?: string }) => e?.message ?? 'unknown'),
}))

// ── Tests ────────────────────────────────────────────────────────────

import {
  categorizeRetryableAPIError,
  classifyAPIError,
} from '../errors.js'

// Helper to create an APIError with a given status and message.
// The Anthropic SDK constructor requires specific arguments;
// we construct a minimal instance that satisfies instanceof checks.
function makeAPIError(status: number, message: string): APIError {
  return new APIError(status, { message }, message, {})
}

describe('categorizeRetryableAPIError', () => {
  it('returns rate_limit for status 529', () => {
    expect(categorizeRetryableAPIError({ status: 529 })).toBe('rate_limit')
  })

  it('returns rate_limit for status 529 with overloaded_error message', () => {
    expect(
      categorizeRetryableAPIError({
        status: 529,
        message: '"type":"overloaded_error"',
      }),
    ).toBe('rate_limit')
  })

  it('returns rate_limit for status 429', () => {
    expect(categorizeRetryableAPIError({ status: 429 })).toBe('rate_limit')
  })

  it('returns authentication_failed for status 401', () => {
    expect(categorizeRetryableAPIError({ status: 401 })).toBe(
      'authentication_failed',
    )
  })

  it('returns authentication_failed for status 403', () => {
    expect(categorizeRetryableAPIError({ status: 403 })).toBe(
      'authentication_failed',
    )
  })

  it('returns server_error for status 500', () => {
    expect(categorizeRetryableAPIError({ status: 500 })).toBe('server_error')
  })

  it('returns server_error for status 408', () => {
    expect(categorizeRetryableAPIError({ status: 408 })).toBe('server_error')
  })

  it('returns unknown when status is undefined', () => {
    expect(categorizeRetryableAPIError({ status: undefined })).toBe('unknown')
  })
})

describe('classifyAPIError', () => {
  it('returns rate_limit for APIError with status 429', () => {
    const error = makeAPIError(429, 'Rate limited')
    expect(classifyAPIError(error)).toBe('rate_limit')
  })

  it('returns server_error for APIError with status 500', () => {
    const error = makeAPIError(500, 'Internal server error')
    expect(classifyAPIError(error)).toBe('server_error')
  })

  it('returns connection_error for APIConnectionError', () => {
    const error = new APIConnectionError({ cause: new Error('ECONNRESET') })
    expect(classifyAPIError(error)).toBe('connection_error')
  })

  it('returns unknown for a plain Error', () => {
    const error = new Error('something went wrong')
    expect(classifyAPIError(error)).toBe('unknown')
  })

  it('returns unknown for a non-error value (does not crash)', () => {
    expect(typeof classifyAPIError(42)).toBe('string')
    expect(typeof classifyAPIError(null)).toBe('string')
    expect(typeof classifyAPIError('oops')).toBe('string')
  })

  it('returns server_overload for APIError with status 529', () => {
    const error = makeAPIError(529, 'Overloaded')
    expect(classifyAPIError(error)).toBe('server_overload')
  })

  it('returns api_timeout for APIConnectionTimeoutError', () => {
    const error = new APIConnectionTimeoutError()
    expect(classifyAPIError(error)).toBe('api_timeout')
  })

  it('returns aborted for Error with "Request was aborted." message', () => {
    const error = new Error('Request was aborted.')
    expect(classifyAPIError(error)).toBe('aborted')
  })

  it('returns prompt_too_long for Error mentioning prompt is too long', () => {
    const error = new Error('Prompt is too long: 137500 tokens > 135000 maximum')
    expect(classifyAPIError(error)).toBe('prompt_too_long')
  })

  it('returns auth_error for APIError with status 401', () => {
    const error = makeAPIError(401, 'Unauthorized')
    expect(classifyAPIError(error)).toBe('auth_error')
  })

  it('returns client_error for APIError with status 400', () => {
    const error = makeAPIError(400, 'Bad request')
    expect(classifyAPIError(error)).toBe('client_error')
  })
})
