import { beforeEach, describe, expect, test } from 'vitest'

import { saveGlobalConfig } from '../../../../utils/config.js'
import { getUserSpecifiedModelSetting } from '../../../../utils/model/model.js'
import type { ModelProviderConfig } from '../../../../utils/config.js'

const model = (id: string): ModelProviderConfig => ({
  model: id,
  protocol: 'openai-chat',
  baseUrl: 'https://example.test/v1',
  apiKey: 'test-key',
})

describe('model resolution', () => {
  beforeEach(() => {
    saveGlobalConfig(current => ({
      ...current,
      models: undefined,
      model: undefined,
      auxiliary: undefined,
    }))
  })

  test('treats an empty first-run config as no selected model', () => {
    expect(getUserSpecifiedModelSetting()).toBeUndefined()
  })

  test('still rejects configured models without an active route', () => {
    saveGlobalConfig(current => ({
      ...current,
      models: {
        main: model('main'),
      },
    }))

    expect(() => getUserSpecifiedModelSetting()).toThrow(
      'No main model route configured',
    )
  })
})
