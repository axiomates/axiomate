import type { ToolCallProgress, ToolUseContext } from '../../Tool.js'
import type { WebSearchProgress } from '../../types/tools.js'
import {
  isSearchProviderError,
  SearchProviderError,
  type SearchProvider,
} from './searchProvider.js'
import type { Output, WebSearchInput } from './types.js'

export async function searchWithProviderFallback(
  providers: SearchProvider[],
  input: WebSearchInput,
  context: ToolUseContext,
  onProgress?: ToolCallProgress<WebSearchProgress>,
): Promise<Output> {
  const errors: SearchProviderError[] = []

  for (const provider of providers) {
    try {
      return await provider.search(input, context, onProgress)
    } catch (error) {
      if (isAbortError(error) || !shouldFallbackToNextProvider(error)) {
        throw error
      }

      errors.push(normalizeSearchProviderError(provider.name, error))
    }
  }

  throw buildAllProvidersFailedError(
    providers.map(provider => provider.name),
    errors,
  )
}

export function shouldFallbackToNextProvider(error: unknown): boolean {
  if (!isSearchProviderError(error)) {
    return false
  }

  return error.code !== 'invalid_request'
}

function normalizeSearchProviderError(
  providerName: string,
  error: unknown,
): SearchProviderError {
  if (isSearchProviderError(error)) {
    return error
  }

  return new SearchProviderError({
    providerName,
    code: 'unknown',
    message: `Search provider ${providerName} failed.`,
    cause: error,
  })
}

function buildAllProvidersFailedError(
  providerNames: string[],
  errors: SearchProviderError[],
): SearchProviderError {
  const details = errors
    .map(error => `${error.providerName}: ${error.message}`)
    .join(' | ')

  return new SearchProviderError({
    providerName: providerNames.join(', '),
    code: errors.at(-1)?.code ?? 'unknown',
    retryable: errors.some(error => error.retryable),
    message: details
      ? `All configured search providers failed. ${details}`
      : 'All configured search providers failed.',
  })
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
