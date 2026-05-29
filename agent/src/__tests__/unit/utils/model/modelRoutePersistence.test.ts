import { describe, expect, test } from 'vitest'

import type { GlobalConfig, ModelProviderConfig } from '../../../../utils/config.js'
import {
  buildAddRouteFallback,
  buildRemoveRouteFallback,
  buildSetAuxiliaryPrimary,
  buildSetDefaultRoute,
  buildSetRoutePrimary,
  buildSinglePrimaryMainRoute,
} from '../../../../utils/model/modelRoutePersistence.js'

const model = (id: string): ModelProviderConfig => ({
  model: id,
  protocol: 'openai-chat',
  baseUrl: 'https://example.test/v1',
  apiKey: 'test-key',
})

const config = (input: Partial<GlobalConfig>): GlobalConfig =>
  input as unknown as GlobalConfig

describe('modelRoutePersistence', () => {
  test('updates the default route primary without inventing config aliases', () => {
    const next = buildSinglePrimaryMainRoute(
      config({
        models: {
          main: model('main'),
          backup: model('backup'),
          next: model('next'),
        },
        model: {
          defaultRoute: 'default',
          routes: {
            default: {
              primary: 'main',
              fallbackChain: ['backup', 'next'],
              recoveryProfile: 'main-agent',
              allowActions: ['retry_same_model', 'adapt_request', 'switch_model'],
              switchModelOn: ['rate_limit'],
            },
          },
        },
      }),
      'next',
    )

    expect(next.model?.routes?.default).toMatchObject({
      primary: 'next',
      fallbackChain: ['backup'],
      recoveryProfile: 'main-agent',
      allowActions: ['retry_same_model', 'adapt_request', 'switch_model'],
      switchModelOn: ['rate_limit'],
    })
  })

  test('creates a normalized default route for fresh model configs', () => {
    const next = buildSinglePrimaryMainRoute(
      config({
        models: {
          next: model('next'),
        },
      }),
      'next',
    )

    expect(next.model?.defaultRoute).toBe('default')
    expect(next.model?.routes?.default).toMatchObject({
      primary: 'next',
      fallbackChain: [],
      recoveryProfile: 'main-agent',
    })
    expect(next.auxiliary?.goalJudge.primary).toBe('next')
  })

  test('sets default route only when the route exists', () => {
    const next = buildSetDefaultRoute(
      config({
        models: {
          main: model('main'),
          fast: model('fast'),
        },
        model: {
          defaultRoute: 'default',
          routes: {
            default: { primary: 'main' },
            fast: { primary: 'fast' },
          },
        },
      }),
      'fast',
    )

    expect(next.model?.defaultRoute).toBe('fast')
    expect(() => buildSetDefaultRoute(next, 'missing')).toThrow(
      'Route "missing" is not defined',
    )
  })

  test('creates or updates named route primary', () => {
    const next = buildSetRoutePrimary(
      config({
        models: {
          main: model('main'),
          fast: model('fast'),
        },
        model: {
          defaultRoute: 'default',
          routes: {
            default: {
              primary: 'main',
              fallbackChain: ['fast'],
            },
          },
        },
      }),
      'cheap',
      'fast',
    )

    expect(next.model?.routes?.cheap).toMatchObject({
      primary: 'fast',
      fallbackChain: [],
    })
  })

  test('adds and removes route fallback models', () => {
    const withFallback = buildAddRouteFallback(
      config({
        models: {
          main: model('main'),
          fast: model('fast'),
        },
        model: {
          defaultRoute: 'default',
          routes: {
            default: { primary: 'main', fallbackChain: [] },
          },
        },
      }),
      'default',
      'fast',
    )

    expect(withFallback.model?.routes?.default.fallbackChain).toEqual(['fast'])
    expect(
      buildRemoveRouteFallback(
        withFallback,
        'default',
        'fast',
      ).model?.routes?.default.fallbackChain,
    ).toEqual([])
  })

  test('sets auxiliary task primary and removes duplicate fallback entry', () => {
    const next = buildSetAuxiliaryPrimary(
      config({
        models: {
          main: model('main'),
          aux: model('aux'),
          backup: model('backup'),
        },
        model: {
          defaultRoute: 'default',
          routes: {
            default: { primary: 'main' },
          },
        },
        auxiliary: {
          goalJudge: {
            primary: 'main',
            fallbackChain: ['aux', 'backup'],
          },
        },
      }),
      'goalJudge',
      'aux',
    )

    expect(next.auxiliary?.goalJudge).toMatchObject({
      primary: 'aux',
      fallbackChain: ['backup'],
    })
  })
})
