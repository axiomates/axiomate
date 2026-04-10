import {
  getGlobalConfig,
  type SearchProviderConfig,
} from '../../utils/config.js'
import {
  SearchProviderError,
  type SearchProvider,
  type SearchProviderFactory,
} from './searchProvider.js'
import { BingWebSearchProvider } from './providers/bingWebSearchProvider.js'
import { GoogleCseSearchProvider } from './providers/googleCseProvider.js'

type SearchProviderResolution = {
  providerName: string
  providerConfig: SearchProviderConfig
  provider: SearchProvider
}

const SEARCH_PROVIDER_FACTORIES = {
  'bing-web-search': {
    type: 'bing-web-search',
    create: (providerName, config) =>
      new BingWebSearchProvider(providerName, config),
  },
  'google-cse': {
    type: 'google-cse',
    create: (providerName, config) =>
      new GoogleCseSearchProvider(providerName, config),
  },
} satisfies Record<SearchProviderConfig['type'], SearchProviderFactory>

export function getSearchProviderForModel(model: string): SearchProvider {
  return resolveSearchProvidersForModel(model)[0].provider
}

export function getSearchProvidersForModel(model: string): SearchProvider[] {
  return resolveSearchProvidersForModel(model).map(
    resolution => resolution.provider,
  )
}

export function resolveSearchProvidersForModel(
  model: string,
): SearchProviderResolution[] {
  const config = getGlobalConfig()
  const modelConfig = config.models?.[model]

  if (!modelConfig) {
    throw new SearchProviderError({
      providerName: 'unconfigured',
      code: 'config',
      message: `Model '${model}' is not configured in ~/.axiomate.json and cannot use WebSearch.`,
    })
  }

  const configuredProviders = config.searchProviders
  if (!configuredProviders || Object.keys(configuredProviders).length === 0) {
    throw new SearchProviderError({
      providerName: 'unconfigured',
      code: 'config',
      message: 'No search providers are configured in ~/.axiomate.json.',
    })
  }

  const providerEntries = getOrderedProviderEntries(configuredProviders)
  const resolutions: SearchProviderResolution[] = []
  const resolutionErrors: SearchProviderError[] = []

  for (const [providerName, providerConfig] of providerEntries) {
    try {
      resolutions.push({
        providerName,
        providerConfig,
        provider: createSearchProvider(providerName, providerConfig),
      })
    } catch (error) {
      if (isRecoverableProviderResolutionError(error)) {
        resolutionErrors.push(error)
        continue
      }
      throw error
    }
  }

  if (resolutions.length > 0) {
    return resolutions
  }

  throw buildNoUsableProvidersError(
    providerEntries.map(([providerName]) => providerName),
    resolutionErrors,
  )
}

function getOrderedProviderEntries(
  configuredProviders: Record<string, SearchProviderConfig>,
): Array<[string, SearchProviderConfig]> {
  return Object.entries(configuredProviders)
}
export function hasSearchProviderForModel(model: string): boolean {
  try {
    resolveSearchProvidersForModel(model)
    return true
  } catch {
    return false
  }
}

function createSearchProvider(
  providerName: string,
  config: SearchProviderConfig,
): SearchProvider {
  const factory = SEARCH_PROVIDER_FACTORIES[config.type]
  if (!factory) {
    throw new SearchProviderError({
      providerName,
      code: 'config',
      message: `Unsupported search provider type '${(config as { type: string }).type}' for '${providerName}'.`,
    })
  }
  return (factory as SearchProviderFactory).create(providerName, config)
}

function isRecoverableProviderResolutionError(
  error: unknown,
): error is SearchProviderError {
  return error instanceof SearchProviderError && error.code === 'config'
}

function buildNoUsableProvidersError(
  providerNames: string[],
  errors: SearchProviderError[],
): SearchProviderError {
  const details = errors
    .map(error => `${error.providerName}: ${error.message}`)
    .join(' | ')

  return new SearchProviderError({
    providerName: providerNames.join(', '),
    code: 'config',
    message: details
      ? `No usable search providers are configured. ${details}`
      : 'No usable search providers are configured.',
  })
}
