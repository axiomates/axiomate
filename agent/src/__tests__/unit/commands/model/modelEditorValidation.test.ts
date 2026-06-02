import { describe, expect, test } from 'vitest'
import type {
  GlobalConfig,
  ModelProviderConfig,
} from '../../../../utils/config.js'
import { validateModelEditConfig } from '../../../../commands/model/modelEditorValidation.js'

const model = (id: string): ModelProviderConfig => ({
  model: id,
  protocol: 'openai-chat',
  baseUrl: 'https://example.test/v1',
  apiKey: 'test-key',
})

const validMainRoute = (primary: string): Pick<GlobalConfig, 'model'> => ({
  model: {
    defaultRoute: 'default',
    routes: {
      default: {
        primary,
      },
    },
  },
})

describe('model editor final config validation', () => {
  test('accepts a model edit when route and auxiliary references remain valid', () => {
    const current: GlobalConfig = {
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
      auxiliary: {
        goalJudge: {
          primary: 'backup',
          fallbackChain: ['main'],
        },
      },
    } as unknown as GlobalConfig

    expect(validateModelEditConfig(current, 'backup', model('backup'))).toBeUndefined()
  })

  test('reports existing route and auxiliary broken references before save', () => {
    const current: GlobalConfig = {
      models: {
        main: model('main'),
      },
      model: {
        defaultRoute: 'default',
        routes: {
          default: {
            primary: 'main',
            fallbackChain: ['missing'],
          },
        },
      },
      auxiliary: {
        goalJudge: {
          primary: 'missing',
          fallbackChain: ['main'],
        },
      },
    } as unknown as GlobalConfig

    const error = validateModelEditConfig(current, 'main', model('main'))
    expect(error).toContain('model.routes.default.fallbackChain[0]')
    expect(error).toContain('auxiliary.goalJudge.primary')
  })

  test('rejects unknown modelTemplate references before save', () => {
    const current: GlobalConfig = {
      models: {
        main: model('main'),
      },
    } as unknown as GlobalConfig

    const error = validateModelEditConfig(current, 'main', {
      ...model('deepseek-v4-pro'),
      modelTemplate: 'does-not-exist',
    })

    expect(error).toContain("references modelTemplate 'does-not-exist'")
  })

  test('rejects incompatible modelTemplate pins before save', () => {
    const current: GlobalConfig = {
      models: {
        main: model('deepseek-v4-pro'),
      },
    } as unknown as GlobalConfig

    const error = validateModelEditConfig(current, 'main', {
      ...model('deepseek-v4-pro'),
      baseUrl: 'https://api.deepseek.com',
      modelTemplate: 'openai-chat-micu-deepseek',
    })

    expect(error).toContain(
      'does not match this model/vendor/protocol/baseUrl',
    )
  })

  test('accepts compatible explicit modelTemplate pins before save', () => {
    const current: GlobalConfig = {
      models: {
        main: model('deepseek-v4-pro'),
      },
      ...validMainRoute('main'),
    } as unknown as GlobalConfig

    expect(
      validateModelEditConfig(current, 'main', {
        ...model('deepseek-v4-pro'),
        baseUrl: 'https://www.micuapi.ai/v1',
        modelTemplate: 'openai-chat-micu-deepseek',
      }),
    ).toBeUndefined()
  })

  test('rejects vendor templates that target a different protocol before save', () => {
    const current: GlobalConfig = {
      models: {
        main: model('main'),
      },
    } as unknown as GlobalConfig

    const error = validateModelEditConfig(current, 'main', {
      ...model('main'),
      protocol: 'anthropic',
      vendor: 'openai-chat-deepseek-official',
    })

    expect(error).toContain("targets protocol 'openai-chat'")
  })

  test('accepts pinning-only vendor templates with no protocol and no extends', () => {
    const current: GlobalConfig = {
      models: {
        main: model('main'),
      },
      ...validMainRoute('main'),
      templates: {
        'pinning-only': {
          enabledPatch: { relay_only: true },
        },
      },
    } as unknown as GlobalConfig

    expect(
      validateModelEditConfig(current, 'main', {
        ...model('main'),
        vendor: 'pinning-only',
      }),
    ).toBeUndefined()
  })
})
