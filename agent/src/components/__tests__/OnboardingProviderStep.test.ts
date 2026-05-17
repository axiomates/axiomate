import { describe, expect, it } from 'vitest'
import {
  buildModelConfig,
  getThinkingChoicesForVendor,
  initialOnboardingProviderState,
  isThinkingChoiceSupported,
  onboardingProviderReducer,
  type OnboardingProviderState,
} from '../OnboardingProviderStep.reducer.js'

describe('onboardingProviderReducer', () => {
  it('starts on the protocol step with an openai default', () => {
    expect(initialOnboardingProviderState.stage).toBe('protocol')
    expect(initialOnboardingProviderState.protocol).toBe('openai-chat')
  })

  it('advances protocol → baseUrl and seeds a protocol-appropriate default baseUrl', () => {
    const next = onboardingProviderReducer(initialOnboardingProviderState, {
      type: 'pickProtocol',
      protocol: 'anthropic',
    })
    expect(next.stage).toBe('baseUrl')
    expect(next.protocol).toBe('anthropic')
    expect(next.baseUrl).toBe('https://api.anthropic.com')
  })

  it('does not overwrite a user-entered baseUrl when the protocol is re-picked', () => {
    const seeded: OnboardingProviderState = {
      ...initialOnboardingProviderState,
      baseUrl: 'http://localhost:11434/v1',
    }
    const next = onboardingProviderReducer(seeded, {
      type: 'pickProtocol',
      protocol: 'openai-chat',
    })
    expect(next.baseUrl).toBe('http://localhost:11434/v1')
  })

  it('trims the baseUrl on submit and advances to apiKey', () => {
    const next = onboardingProviderReducer(
      { ...initialOnboardingProviderState, stage: 'baseUrl' },
      { type: 'submitBaseUrl', value: '  https://example.com/v1  ' },
    )
    expect(next.stage).toBe('apiKey')
    expect(next.baseUrl).toBe('https://example.com/v1')
  })

  it('preserves the apiKey verbatim (no trim — keys may have whitespace)', () => {
    // OpenAI keys don't have whitespace in practice, but some custom providers
    // use quoted strings or header-prefixed values. Don't second-guess input.
    const next = onboardingProviderReducer(
      { ...initialOnboardingProviderState, stage: 'apiKey' },
      { type: 'submitApiKey', value: 'sk-test-123' },
    )
    expect(next.stage).toBe('modelId')
    expect(next.apiKey).toBe('sk-test-123')
    expect(next.error).toBeUndefined()
  })

  it('advances modelId → contextWindow', () => {
    const next = onboardingProviderReducer(
      { ...initialOnboardingProviderState, stage: 'modelId' },
      { type: 'submitModelId', value: 'gpt-4o' },
    )
    expect(next.stage).toBe('contextWindow')
    expect(next.modelId).toBe('gpt-4o')
  })

  it('parses contextWindow input and advances to supportsImages', () => {
    const next = onboardingProviderReducer(
      { ...initialOnboardingProviderState, stage: 'contextWindow' },
      { type: 'submitContextWindow', value: '200000' },
    )
    expect(next.stage).toBe('supportsImages')
    expect(next.contextWindow).toBe(200_000)
  })

  it('accepts empty contextWindow input and uses 32K default', () => {
    const next = onboardingProviderReducer(
      { ...initialOnboardingProviderState, stage: 'contextWindow' },
      { type: 'submitContextWindow', value: '' },
    )
    expect(next.stage).toBe('supportsImages')
    expect(next.contextWindow).toBe(32_000)
  })

  it('rejects non-numeric contextWindow and stays on stage with error', () => {
    const next = onboardingProviderReducer(
      { ...initialOnboardingProviderState, stage: 'contextWindow' },
      { type: 'submitContextWindow', value: 'abc' },
    )
    expect(next.stage).toBe('contextWindow')
    expect(next.error).toBeDefined()
  })

  it('submitSupportsImages advances to vendor and stores the choice', () => {
    const next = onboardingProviderReducer(
      { ...initialOnboardingProviderState, stage: 'supportsImages' },
      { type: 'submitSupportsImages', value: false },
    )
    expect(next.stage).toBe('vendor')
    expect(next.supportsImages).toBe(false)
  })

  it('submitVendor advances to thinking and stores the vendor', () => {
    const next = onboardingProviderReducer(
      { ...initialOnboardingProviderState, stage: 'vendor' },
      { type: 'submitVendor', value: 'deepseek-reasoning', nextThinking: 'high' },
    )
    expect(next.stage).toBe('thinking')
    expect(next.vendor).toBe('deepseek-reasoning')
  })

  it('submitVendor honors the dispatcher-provided nextThinking (vendor mismatch resets)', () => {
    // Caller (dispatcher) decides whether the previous thinking choice
    // is still supported — the reducer just stores what it's given.
    const next = onboardingProviderReducer(
      {
        ...initialOnboardingProviderState,
        stage: 'vendor',
        thinking: 'low',
      },
      { type: 'submitVendor', value: 'deepseek-reasoning', nextThinking: 'off' },
    )
    expect(next.stage).toBe('thinking')
    expect(next.thinking).toBe('off')
  })

  it('startCreateTemplate enters createTemplate stage', () => {
    const next = onboardingProviderReducer(
      { ...initialOnboardingProviderState, stage: 'vendor' },
      { type: 'startCreateTemplate' },
    )
    expect(next.stage).toBe('createTemplate')
  })

  it('finishCreateTemplate sets vendor to new template name and advances to thinking', () => {
    const next = onboardingProviderReducer(
      { ...initialOnboardingProviderState, stage: 'createTemplate' },
      { type: 'finishCreateTemplate', templateName: 'my-private-api', nextThinking: 'off' },
    )
    expect(next.stage).toBe('thinking')
    expect(next.vendor).toBe('my-private-api')
  })

  it('cancelCreateTemplate returns to vendor stage without changing vendor', () => {
    const next = onboardingProviderReducer(
      {
        ...initialOnboardingProviderState,
        stage: 'createTemplate',
        vendor: 'auto',
      },
      { type: 'cancelCreateTemplate' },
    )
    expect(next.stage).toBe('vendor')
    expect(next.vendor).toBe('auto')
  })

  it('submitThinking advances to userAgent and stores the level', () => {
    const next = onboardingProviderReducer(
      { ...initialOnboardingProviderState, stage: 'thinking' },
      { type: 'submitThinking', value: 'high' },
    )
    expect(next.stage).toBe('userAgent')
    expect(next.thinking).toBe('high')
  })

  it('submitThinking with off keeps default and advances', () => {
    const next = onboardingProviderReducer(
      { ...initialOnboardingProviderState, stage: 'thinking' },
      { type: 'submitThinking', value: 'off' },
    )
    expect(next.stage).toBe('userAgent')
    expect(next.thinking).toBe('off')
  })

  it('submitUserAgent trims and advances to verifying', () => {
    const next = onboardingProviderReducer(
      { ...initialOnboardingProviderState, stage: 'userAgent' },
      { type: 'submitUserAgent', value: '  codex_cli_rs/0.50.0  ' },
    )
    expect(next.stage).toBe('verifying')
    expect(next.userAgent).toBe('codex_cli_rs/0.50.0')
  })

  it('submitUserAgent accepts empty input (keeps SDK default)', () => {
    const next = onboardingProviderReducer(
      { ...initialOnboardingProviderState, stage: 'userAgent' },
      { type: 'submitUserAgent', value: '' },
    )
    expect(next.stage).toBe('verifying')
    expect(next.userAgent).toBe('')
  })

  it('routes verify failure to a dedicated verifyFailed stage with the error', () => {
    const next = onboardingProviderReducer(
      { ...initialOnboardingProviderState, stage: 'verifying' },
      { type: 'verifyFail', error: 'bad key' },
    )
    expect(next.stage).toBe('verifyFailed')
    expect(next.error).toBe('bad key')
  })

  it('retryFromApiKey returns to apiKey and clears the error', () => {
    const next = onboardingProviderReducer(
      {
        ...initialOnboardingProviderState,
        stage: 'verifyFailed',
        error: 'bad key',
      },
      { type: 'retryFromApiKey' },
    )
    expect(next.stage).toBe('apiKey')
    expect(next.error).toBeUndefined()
  })

  it('back from baseUrl returns to protocol', () => {
    const next = onboardingProviderReducer(
      { ...initialOnboardingProviderState, stage: 'baseUrl' },
      { type: 'back' },
    )
    expect(next.stage).toBe('protocol')
  })

  it('back from apiKey returns to baseUrl', () => {
    const next = onboardingProviderReducer(
      { ...initialOnboardingProviderState, stage: 'apiKey' },
      { type: 'back' },
    )
    expect(next.stage).toBe('baseUrl')
  })

  it('back from modelId returns to apiKey', () => {
    const next = onboardingProviderReducer(
      { ...initialOnboardingProviderState, stage: 'modelId' },
      { type: 'back' },
    )
    expect(next.stage).toBe('apiKey')
  })

  it('back from contextWindow returns to modelId', () => {
    const next = onboardingProviderReducer(
      { ...initialOnboardingProviderState, stage: 'contextWindow' },
      { type: 'back' },
    )
    expect(next.stage).toBe('modelId')
  })

  it('back from supportsImages returns to contextWindow', () => {
    const next = onboardingProviderReducer(
      { ...initialOnboardingProviderState, stage: 'supportsImages' },
      { type: 'back' },
    )
    expect(next.stage).toBe('contextWindow')
  })

  it('back from thinking returns to vendor', () => {
    const next = onboardingProviderReducer(
      { ...initialOnboardingProviderState, stage: 'thinking' },
      { type: 'back' },
    )
    expect(next.stage).toBe('vendor')
  })

  it('back from vendor returns to supportsImages', () => {
    const next = onboardingProviderReducer(
      { ...initialOnboardingProviderState, stage: 'vendor' },
      { type: 'back' },
    )
    expect(next.stage).toBe('supportsImages')
  })

  it('back from userAgent returns to thinking', () => {
    const next = onboardingProviderReducer(
      { ...initialOnboardingProviderState, stage: 'userAgent' },
      { type: 'back' },
    )
    expect(next.stage).toBe('thinking')
  })

  it('back from verifyFailed returns to userAgent (re-confirm the last input)', () => {
    const next = onboardingProviderReducer(
      {
        ...initialOnboardingProviderState,
        stage: 'verifyFailed',
        error: 'bad key',
      },
      { type: 'back' },
    )
    expect(next.stage).toBe('userAgent')
    expect(next.error).toBeUndefined()
  })

  it('back from protocol is a no-op (parent handles cancel)', () => {
    const next = onboardingProviderReducer(initialOnboardingProviderState, {
      type: 'back',
    })
    expect(next.stage).toBe('protocol')
  })
})

describe('full happy-path transition', () => {
  it('protocol → baseUrl → apiKey → modelId → contextWindow → supportsImages → thinking → userAgent → verifying carries all values', () => {
    let state = initialOnboardingProviderState
    state = onboardingProviderReducer(state, {
      type: 'pickProtocol',
      protocol: 'openai-chat',
    })
    state = onboardingProviderReducer(state, {
      type: 'submitBaseUrl',
      value: 'https://openrouter.ai/api/v1',
    })
    state = onboardingProviderReducer(state, {
      type: 'submitApiKey',
      value: 'sk-or-v1-abc',
    })
    state = onboardingProviderReducer(state, {
      type: 'submitModelId',
      value: 'qwen/qwen3-235b',
    })
    state = onboardingProviderReducer(state, {
      type: 'submitContextWindow',
      value: '128000',
    })
    state = onboardingProviderReducer(state, {
      type: 'submitSupportsImages',
      value: false,
    })
    state = onboardingProviderReducer(state, {
      type: 'submitVendor',
      value: 'auto',
      nextThinking: 'high',
    })
    state = onboardingProviderReducer(state, {
      type: 'submitThinking',
      value: 'high',
    })
    state = onboardingProviderReducer(state, {
      type: 'submitUserAgent',
      value: 'codex_cli_rs/0.50.0',
    })
    expect(state).toMatchObject({
      stage: 'verifying',
      protocol: 'openai-chat',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-v1-abc',
      modelId: 'qwen/qwen3-235b',
      contextWindow: 128_000,
      supportsImages: false,
      vendor: 'auto',
      thinking: 'high',
      userAgent: 'codex_cli_rs/0.50.0',
    })
  })
})

describe('buildModelConfig', () => {
  it('shapes the models[modelId] entry per ModelProviderConfig with defaults omitted', () => {
    const state: OnboardingProviderState = {
      stage: 'verifying',
      protocol: 'openai-chat',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-v1-abc',
      modelId: 'qwen/qwen3-235b',
      contextWindow: 128_000,
      supportsImages: true,
      userAgent: '',
      thinking: 'off',
      vendor: 'auto',
    }
    expect(buildModelConfig(state)).toEqual({
      model: 'qwen/qwen3-235b',
      name: 'qwen/qwen3-235b',
      protocol: 'openai-chat',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-v1-abc',
      contextWindow: 128_000,
    })
  })

  it('emits supportsImages: false when user explicitly disabled images', () => {
    const state: OnboardingProviderState = {
      stage: 'verifying',
      protocol: 'openai-chat',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      modelId: 'deepseek-v4-pro',
      contextWindow: 1_000_000,
      supportsImages: false,
      userAgent: '',
      thinking: 'off',
      vendor: 'auto',
    }
    expect(buildModelConfig(state)).toMatchObject({ supportsImages: false })
  })

  it('emits thinking: { enabled: true, effort } when wizard chose a level', () => {
    const state: OnboardingProviderState = {
      stage: 'verifying',
      protocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      modelId: 'o4-mini',
      contextWindow: 200_000,
      supportsImages: true,
      thinking: 'high',
      userAgent: '',
      vendor: 'auto',
    }
    expect(buildModelConfig(state)).toMatchObject({
      thinking: { enabled: true, effort: 'high' },
    })
  })

  it('omits thinking field entirely when wizard chose Off', () => {
    const state: OnboardingProviderState = {
      stage: 'verifying',
      protocol: 'openai-chat',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      modelId: 'plain-model',
      contextWindow: 32_000,
      supportsImages: true,
      thinking: 'off',
      userAgent: '',
      vendor: 'auto',
    }
    const cfg = buildModelConfig(state)
    expect('thinking' in cfg).toBe(false)
  })

  it('emits userAgent when set, omits it otherwise', () => {
    const base: OnboardingProviderState = {
      stage: 'verifying',
      protocol: 'openai-responses',
      baseUrl: 'https://gateway.example.com/v1',
      apiKey: 'sk-test',
      modelId: 'gpt-5.4',
      contextWindow: 1_000_000,
      supportsImages: true,
      userAgent: 'codex_cli_rs/0.50.0',
      thinking: 'off',
      vendor: 'auto',
    }
    expect(buildModelConfig(base)).toMatchObject({
      userAgent: 'codex_cli_rs/0.50.0',
    })
    const withoutUa = buildModelConfig({ ...base, userAgent: '' })
    expect('userAgent' in withoutUa).toBe(false)
  })
})

describe('getThinkingChoicesForVendor', () => {
  it("'auto' returns all 5 choices (vendor not yet known)", () => {
    expect(getThinkingChoicesForVendor('auto')).toEqual([
      'off',
      'low',
      'medium',
      'high',
      'max',
    ])
  })

  it('undefined vendor returns all 5 choices', () => {
    expect(getThinkingChoicesForVendor(undefined)).toEqual([
      'off',
      'low',
      'medium',
      'high',
      'max',
    ])
  })

  it('anthropic offers off/low/medium/high (no max)', () => {
    expect(getThinkingChoicesForVendor('anthropic')).toEqual([
      'off',
      'low',
      'medium',
      'high',
    ])
  })

  it('deepseek-reasoning offers off/high/max only', () => {
    expect(getThinkingChoicesForVendor('deepseek-reasoning')).toEqual([
      'off',
      'high',
      'max',
    ])
  })

  it('openai-ali-thinking offers off/high/max only', () => {
    expect(getThinkingChoicesForVendor('openai-ali-thinking')).toEqual([
      'off',
      'high',
      'max',
    ])
  })

  it('openai-siliconflow-thinking offers off/high/max only', () => {
    expect(
      getThinkingChoicesForVendor('openai-siliconflow-thinking'),
    ).toEqual(['off', 'high', 'max'])
  })

  it('openai-default offers all 5 choices', () => {
    expect(getThinkingChoicesForVendor('openai-default')).toEqual([
      'off',
      'low',
      'medium',
      'high',
      'max',
    ])
  })

  it('unknown vendor with no custom template falls back to all 5', () => {
    expect(getThinkingChoicesForVendor('does-not-exist')).toEqual([
      'off',
      'low',
      'medium',
      'high',
      'max',
    ])
  })

  it('custom template with partial valueMap is honored', () => {
    expect(
      getThinkingChoicesForVendor('my-vendor', {
        'my-vendor': {
          effort: {
            patch: { reasoning_effort: '<value>' },
            valueMap: { medium: 'medium', high: 'high' },
          },
        },
      }),
    ).toEqual(['off', 'medium', 'high'])
  })

  it('custom template with no effort field offers off only', () => {
    expect(
      getThinkingChoicesForVendor('no-effort', {
        'no-effort': {},
      }),
    ).toEqual(['off'])
  })
})

describe('isThinkingChoiceSupported', () => {
  it("'off' is always supported", () => {
    expect(isThinkingChoiceSupported('off', 'anthropic')).toBe(true)
    expect(isThinkingChoiceSupported('off', 'deepseek-reasoning')).toBe(true)
  })

  it("anthropic + 'max' is unsupported (vendor mismatch)", () => {
    expect(isThinkingChoiceSupported('max', 'anthropic')).toBe(false)
  })

  it("deepseek + 'low' is unsupported", () => {
    expect(isThinkingChoiceSupported('low', 'deepseek-reasoning')).toBe(false)
  })

  it("anthropic + 'high' is supported", () => {
    expect(isThinkingChoiceSupported('high', 'anthropic')).toBe(true)
  })
})
