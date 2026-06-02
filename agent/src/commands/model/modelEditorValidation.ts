import type { GlobalConfig, ModelProviderConfig } from '../../utils/config.js'
import {
  validateModelRoutingConfig,
  type RouteValidationIssue,
} from '../../utils/model/modelRouting.js'
import {
  getBuiltinModelTemplates,
  getBuiltinTemplates,
  isBuiltinModelTemplate,
  isBuiltinVendor,
  PROTOCOLS,
  resolveStack,
  resolveTemplate,
} from '../../services/api/vendorTemplates.js'

const builtinVendorList = [
  ...PROTOCOLS,
  ...Object.keys(getBuiltinTemplates()),
].map(name => `'${name}'`).join(', ')

const builtinModelTemplateList = Object.keys(getBuiltinModelTemplates())
  .map(name => `'${name}'`)
  .join(', ')

export function validateModelEditConfig(
  current: GlobalConfig,
  modelId: string,
  nextModelConfig: ModelProviderConfig,
): string | undefined {
  const templateError = validateTemplateReferences(
    current,
    modelId,
    nextModelConfig,
  )
  if (templateError) return templateError

  const nextConfig: GlobalConfig = {
    ...current,
    models: {
      ...(current.models ?? {}),
      [modelId]: nextModelConfig,
    },
  }
  const issues = validateModelRoutingConfig(nextConfig)
  return issues.length > 0 ? formatRouteValidationIssues(issues) : undefined
}

function validateTemplateReferences(
  current: GlobalConfig,
  modelId: string,
  nextModelConfig: ModelProviderConfig,
): string | undefined {
  const customVendors = current.templates
  const customModels = current.modelTemplates

  if (nextModelConfig.vendor) {
    if (
      !isBuiltinVendor(nextModelConfig.vendor) &&
      !customVendors?.[nextModelConfig.vendor]
    ) {
      return (
        `Model '${modelId}' references vendor '${nextModelConfig.vendor}', ` +
        `which is neither a built-in template nor defined in config.templates. ` +
        `Built-in templates: ${builtinVendorList}. ` +
        `For vanilla protocols leave 'vendor' unset, or use the protocol name itself.`
      )
    }

    try {
      const tpl = resolveTemplate(nextModelConfig.vendor, customVendors)
      if (
        tpl.protocol !== undefined &&
        tpl.protocol !== nextModelConfig.protocol
      ) {
        return (
          `Model '${modelId}' uses vendor template '${nextModelConfig.vendor}' ` +
          `with protocol '${nextModelConfig.protocol}', but that template targets ` +
          `protocol '${tpl.protocol}'. Either change the model's protocol, or pick ` +
          `a vendor template compatible with '${nextModelConfig.protocol}'.`
        )
      }
    } catch (err) {
      return `Model '${modelId}': ${err instanceof Error ? err.message : String(err)}`
    }
  }

  if (nextModelConfig.modelTemplate) {
    if (
      !isBuiltinModelTemplate(nextModelConfig.modelTemplate) &&
      !customModels?.[nextModelConfig.modelTemplate]
    ) {
      return (
        `Model '${modelId}' references modelTemplate '${nextModelConfig.modelTemplate}', ` +
        `which is neither a built-in template nor defined in config.modelTemplates. ` +
        `Built-in model templates: ${builtinModelTemplateList || '(none)'}. ` +
        `Leave 'modelTemplate' unset to apply no model-layer template.`
      )
    }
  }

  try {
    resolveStack({
      protocol: nextModelConfig.protocol,
      vendor: nextModelConfig.vendor,
      modelTemplate: nextModelConfig.modelTemplate,
      model: nextModelConfig.model,
      baseUrl: nextModelConfig.baseUrl,
      customVendors,
      customModels,
    })
  } catch (err) {
    return `Model '${modelId}': ${err instanceof Error ? err.message : String(err)}`
  }

  return undefined
}

export function formatRouteValidationIssues(
  issues: RouteValidationIssue[],
): string {
  return `Model routing validation failed:\n${issues
    .map(issue => `  - ${issue.path}: ${issue.message}`)
    .join('\n')}`
}
