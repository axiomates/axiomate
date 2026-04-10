import { getGlobalConfig, type ModelProviderConfig } from './config.js'

export function findModelProviderConfigForResponseModel(
  responseModel: string | undefined,
  models: Record<string, ModelProviderConfig> | undefined = getGlobalConfig()
    .models,
): ModelProviderConfig | undefined {
  if (!responseModel || !models) {
    return undefined
  }

  for (const modelConfig of Object.values(models)) {
    if (modelConfig.model === responseModel) {
      return modelConfig
    }
  }
  return undefined
}

export function shouldRepairToolCallsForResponseModel(
  responseModel: string | undefined,
  models: Record<string, ModelProviderConfig> | undefined = getGlobalConfig()
    .models,
): boolean {
  return (
    findModelProviderConfigForResponseModel(responseModel, models)
      ?.repairToolCalls === true
  )
}
