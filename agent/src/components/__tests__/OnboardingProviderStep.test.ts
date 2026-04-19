import { describe, expect, it } from 'vitest'
import {
  buildModelConfig,
  initialOnboardingProviderState,
  onboardingProviderReducer,
  type OnboardingProviderState,
} from '../OnboardingProviderStep.reducer.js'

describe('onboardingProviderReducer', () => {
  it('starts on the protocol step with an openai default', () => {
    expect(initialOnboardingProviderState.stage).toBe('protocol')
    expect(initialOnboardingProviderState.protocol).toBe('openai')
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
      protocol: 'openai',
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

  it('parses contextWindow input and advances to verifying', () => {
    const next = onboardingProviderReducer(
      { ...initialOnboardingProviderState, stage: 'contextWindow' },
      { type: 'submitContextWindow', value: '200000' },
    )
    expect(next.stage).toBe('verifying')
    expect(next.contextWindow).toBe(200_000)
  })

  it('accepts empty contextWindow input and uses 32K default', () => {
    const next = onboardingProviderReducer(
      { ...initialOnboardingProviderState, stage: 'contextWindow' },
      { type: 'submitContextWindow', value: '' },
    )
    expect(next.stage).toBe('verifying')
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

  it('back from verifyFailed returns to contextWindow (re-confirm the last input)', () => {
    const next = onboardingProviderReducer(
      {
        ...initialOnboardingProviderState,
        stage: 'verifyFailed',
        error: 'bad key',
      },
      { type: 'back' },
    )
    expect(next.stage).toBe('contextWindow')
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
  it('protocol → baseUrl → apiKey → modelId → contextWindow → verifying carries all values', () => {
    let state = initialOnboardingProviderState
    state = onboardingProviderReducer(state, {
      type: 'pickProtocol',
      protocol: 'openai',
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
    expect(state).toMatchObject({
      stage: 'verifying',
      protocol: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-v1-abc',
      modelId: 'qwen/qwen3-235b',
      contextWindow: 128_000,
    })
  })
})

describe('buildModelConfig', () => {
  it('shapes the models[modelId] entry per ModelProviderConfig', () => {
    const state: OnboardingProviderState = {
      stage: 'verifying',
      protocol: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-v1-abc',
      modelId: 'qwen/qwen3-235b',
      contextWindow: 128_000,
    }
    expect(buildModelConfig(state)).toEqual({
      model: 'qwen/qwen3-235b',
      name: 'qwen/qwen3-235b',
      protocol: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-v1-abc',
      contextWindow: 128_000,
    })
  })
})
