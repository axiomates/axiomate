import { describe, expect, test, vi } from 'vitest'
import {
  findModelProviderConfigForResponseModel,
  shouldRepairToolCallsForResponseModel,
} from '../../../utils/modelProviderConfig.js'

vi.mock('../../../utils/config.js', () => ({
  getGlobalConfig: () => ({ models: undefined }),
}))

type TestModelProviderConfig = {
  model: string
  protocol: 'openai-chat' | 'anthropic'
  baseUrl: string
  apiKey: string
  repairToolCalls?: boolean
}

function modelConfig(
  model: string,
  repairToolCalls?: boolean,
): TestModelProviderConfig {
  return {
    model,
    protocol: 'openai-chat',
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key',
    ...(repairToolCalls === undefined ? {} : { repairToolCalls }),
  }
}

describe('modelProviderConfig', () => {
  test('enables tool call repair only for the strictly matching model field', () => {
    const models = {
      repairAlias: modelConfig('Provider/RepairProne-8B', true),
      reliableAlias: modelConfig('Provider/Reliable-Plus', false),
      defaultOffAlias: modelConfig('Provider/Default-Off'),
    }

    expect(
      shouldRepairToolCallsForResponseModel('Provider/RepairProne-8B', models),
    ).toBe(true)
    expect(
      shouldRepairToolCallsForResponseModel('Provider/Reliable-Plus', models),
    ).toBe(false)
    expect(
      shouldRepairToolCallsForResponseModel('Provider/Default-Off', models),
    ).toBe(false)
    expect(
      shouldRepairToolCallsForResponseModel('Unknown/Model', models),
    ).toBe(false)
  })

  test('does not match the config key when it differs from the model field', () => {
    const models = {
      friendlyAlias: modelConfig('Provider/RepairProne-8B', true),
    }

    expect(shouldRepairToolCallsForResponseModel('friendlyAlias', models)).toBe(
      false,
    )
  })

  test('does not case-normalize provider response model names', () => {
    const models = {
      repairAlias: modelConfig('Provider/RepairProne-8B', true),
    }

    expect(
      shouldRepairToolCallsForResponseModel('provider/repairprone-8b', models),
    ).toBe(false)
  })

  test('does not use loose tail matching', () => {
    const models = {
      repairAlias: modelConfig('Provider/RepairProne-8B', true),
    }

    expect(shouldRepairToolCallsForResponseModel('repairprone-8b', models)).toBe(
      false,
    )
    expect(
      findModelProviderConfigForResponseModel('repairprone-8b', models),
    ).toBe(undefined)
  })
})
