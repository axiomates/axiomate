import { describe, expect, test } from 'vitest'

import type { GlobalConfig, ModelProviderConfig } from '../../../../utils/config.js'
import {
  getAuxiliaryTaskPolicyFromConfig,
  getMainRouteFromConfig,
  normalizeModelRoutingConfig,
  resolveMainModelOverride,
  resolveModelChainFromRoute,
  validateModelRoutingConfig,
} from '../../../../utils/model/modelRouting.js'

const model = (
  id: string,
  overrides: Partial<ModelProviderConfig> = {},
): ModelProviderConfig => ({
  model: id,
  protocol: 'openai-chat',
  baseUrl: 'https://example.test/v1',
  apiKey: 'test-key',
  ...overrides,
})

const config = (input: Partial<GlobalConfig>): GlobalConfig =>
  input as unknown as GlobalConfig

describe('modelRouting', () => {
  test('normalizes the final route config without inventing route shape', () => {
    const routeConfig = config({
      models: {
        main: model('main'),
        backup: model('backup'),
      },
      model: {
        defaultRoute: 'default',
        routes: {
          default: {
            primary: 'main',
            fallbackChain: ['backup'],
          },
        },
      },
    })

    const normalized = normalizeModelRoutingConfig(routeConfig)

    expect(normalized.model?.defaultRoute).toBe('default')
    expect(normalized.model?.routes?.default).toMatchObject({
      primary: 'main',
      fallbackChain: ['backup'],
      recoveryProfile: 'main-agent',
      allowActions: ['retry_same_model', 'adapt_request', 'switch_model'],
    })
    expect(normalized.model?.routes?.default.switchModelOn).toContain(
      'rate_limit',
    )
    expect(normalized.model?.routes?.default.switchModelOn).toContain(
      'content_policy_blocked',
    )

    expect(normalized.auxiliary?.goalJudge).toMatchObject({
      primary: 'main',
      fallbackChain: [],
      recoveryProfile: 'auxiliary-judge',
      failure: 'fail_open',
    })
    expect(normalized.auxiliary?.sessionTitle).toMatchObject({
      primary: 'main',
      fallbackChain: [],
      recoveryProfile: 'auxiliary-fast',
      failure: 'return_null',
    })
  })

  test('does not synthesize a main route from the models map', () => {
    const normalized = normalizeModelRoutingConfig(config({
      models: {
        main: model('main'),
      },
    }))

    expect(normalized.model).toBeUndefined()
    expect(normalized.auxiliary).toBeUndefined()
    expect(() => getMainRouteFromConfig(normalized)).toThrow(
      'No main model route configured',
    )
    expect(validateModelRoutingConfig(normalized).map(issue => issue.path))
      .toEqual(['model.defaultRoute'])
  })

  test('uses explicit route and auxiliary policies', () => {
    const explicitConfig = config({
      models: {
        main: model('main'),
        backup: model('backup'),
        aux: model('aux'),
      },
      model: {
        defaultRoute: 'quality',
        routes: {
          quality: {
            primary: 'main',
            fallbackChain: ['backup'],
            recoveryProfile: 'main-agent',
            allowActions: ['switch_model'],
            switchModelOn: ['rate_limit'],
          },
        },
      },
      auxiliary: {
        goalJudge: {
          primary: 'aux',
          fallbackChain: ['backup'],
          recoveryProfile: 'auxiliary-judge',
          allowActions: ['retry_same_model'],
          switchModelOn: ['timeout'],
          failure: 'fail_closed',
        },
      },
    })

    const mainRoute = getMainRouteFromConfig(explicitConfig)
    const goalJudge = getAuxiliaryTaskPolicyFromConfig(explicitConfig, 'goalJudge')

    expect(mainRoute).toMatchObject({
      id: 'quality',
      primary: 'main',
      fallbackChain: ['backup'],
      allowActions: ['switch_model'],
      switchModelOn: ['rate_limit'],
    })
    expect(goalJudge).toMatchObject({
      task: 'goalJudge',
      primary: 'aux',
      fallbackChain: ['backup'],
      allowActions: ['retry_same_model'],
      switchModelOn: ['timeout'],
      failure: 'fail_closed',
    })
  })

  test('validates route primary and fallback references against models map', () => {
    const issues = validateModelRoutingConfig(config({
      models: {
        main: model('main'),
      },
      model: {
        defaultRoute: 'default',
        routes: {
          default: {
            primary: 'missing',
            fallbackChain: ['main', 'main', 'also-missing'],
          },
        },
      },
      auxiliary: {
        goalJudge: {
          primary: 'main',
          fallbackChain: ['main'],
        },
      },
    }))

    expect(issues.map(issue => issue.path)).toEqual([
      'model.routes.default.primary',
      'model.routes.default.fallbackChain[1]',
      'model.routes.default.fallbackChain[2]',
      'auxiliary.goalJudge.fallbackChain[0]',
    ])
  })

  test('requires an explicit default route when models are configured', () => {
    const issues = validateModelRoutingConfig(config({
      models: {
        main: model('main'),
      },
      model: {
        routes: {
          default: {
            primary: 'main',
          },
        },
      },
    }))

    expect(issues.map(issue => issue.path)).toEqual(['model.defaultRoute'])
  })

  test('validates policy action, switch reason, and auxiliary failure values', () => {
    const issues = validateModelRoutingConfig(config({
      models: {
        main: model('main'),
      },
      model: {
        defaultRoute: 'default',
        routes: {
          default: {
            primary: 'main',
            allowActions: ['switch_model', 'fallback_now'],
            switchModelOn: ['rate_limit', 'bad_reason'],
          } as never,
        },
      },
      auxiliary: {
        goalJudge: {
          primary: 'main',
          failure: 'explode',
        } as never,
      },
    }))

    expect(issues.map(issue => issue.path)).toEqual([
      'model.routes.default.allowActions[1]',
      'model.routes.default.switchModelOn[1]',
      'auxiliary.goalJudge.failure',
    ])
  })

  test('validates fallbackChain shape before normalizing values', () => {
    const issues = validateModelRoutingConfig(config({
      models: {
        main: model('main'),
      },
      model: {
        defaultRoute: 'default',
        routes: {
          default: {
            primary: 'main',
            fallbackChain: 'backup',
          } as never,
        },
      },
    }))

    expect(issues.map(issue => issue.path)).toEqual([
      'model.routes.default.fallbackChain',
    ])
  })

  test('resolves model chain as primary followed by ordered unique fallback models', () => {
    expect(
      resolveModelChainFromRoute({
        primary: 'main',
        fallbackChain: ['backup', 'main', 'backup', 'fast'],
      }),
    ).toEqual(['main', 'backup', 'fast'])
  })

  test('resolves main model overrides as route semantics', () => {
    const cfg = config({
      models: {
        main: model('main'),
        backup: model('backup'),
        solo: model('solo'),
      },
      model: {
        defaultRoute: 'default',
        routes: {
          default: {
            primary: 'main',
            fallbackChain: ['backup'],
          },
          cheap: {
            primary: 'backup',
            fallbackChain: [],
          },
        },
      },
    })

    expect(resolveMainModelOverride(cfg, undefined)).toMatchObject({
      id: 'default',
      primary: 'main',
      fallbackChain: ['backup'],
    })
    expect(resolveMainModelOverride(cfg, { type: 'route', routeId: 'cheap' }))
      .toMatchObject({
        id: 'cheap',
        primary: 'backup',
        fallbackChain: [],
      })
    expect(
      resolveMainModelOverride(cfg, {
        type: 'single-model-route',
        modelId: 'solo',
      }),
    ).toMatchObject({
      id: 'session:solo',
      primary: 'solo',
      fallbackChain: [],
    })
  })
})
