import { isModelAllowed } from './modelAllowlist.js'
import { sideQuery } from '../../services/api/capabilities/sideQuery.js'
import { getProviderForModel } from '../../services/api/providerRegistry.js'
import { LLMAPIError } from '../../services/api/streamTypes.js'

// Cache valid models to avoid repeated API calls
const validModelCache = new Map<string, boolean>()

/**
 * Validates a model by attempting an actual API call.
 */
export async function validateModel(
  model: string,
): Promise<{ valid: boolean; error?: string }> {
  const normalizedModel = model.trim()

  // Empty model is invalid
  if (!normalizedModel) {
    return { valid: false, error: 'Model name cannot be empty' }
  }

  // Check against availableModels allowlist before any API call
  if (!isModelAllowed(normalizedModel)) {
    return {
      valid: false,
      error: `Model '${normalizedModel}' is not in the list of available models`,
    }
  }

  // Check cache first
  if (validModelCache.has(normalizedModel)) {
    return { valid: true }
  }


  // Try to make an actual API call with minimal parameters
  try {
    await sideQuery(getProviderForModel(normalizedModel), {
      model: normalizedModel,
      maxTokens: 1,
      maxRetries: 0,
      querySource: 'model_validation',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Hi',
            },
          ],
        },
      ],
    })

    // If we got here, the model is valid
    validModelCache.set(normalizedModel, true)
    return { valid: true }
  } catch (error) {
    return handleValidationError(error, normalizedModel)
  }
}

function handleValidationError(
  error: unknown,
  modelName: string,
): { valid: boolean; error: string } {
  // Use neutral LLMAPIError for all provider error classification
  if (error instanceof LLMAPIError) {
    // 404 means the model doesn't exist
    if (error.status === 404) {
      return {
        valid: false,
        error: `Model '${modelName}' not found`,
      }
    }

    // Authentication errors
    if (error.status === 401 || error.status === 403) {
      return {
        valid: false,
        error: 'Authentication failed. Please check your API credentials.',
      }
    }

    // Connection errors (no status code)
    if (!error.status) {
      return {
        valid: false,
        error: 'Network error. Please check your internet connection.',
      }
    }

    // Check error body for model-specific errors
    const errorBody = error.error as unknown
    if (
      errorBody &&
      typeof errorBody === 'object' &&
      'type' in errorBody &&
      errorBody.type === 'not_found_error' &&
      'message' in errorBody &&
      typeof errorBody.message === 'string' &&
      errorBody.message.includes('model:')
    ) {
      return { valid: false, error: `Model '${modelName}' not found` }
    }

    // Generic API error
    return { valid: false, error: `API error: ${error.message}` }
  }

  // For unknown errors, be safe and reject
  const errorMessage = error instanceof Error ? error.message : String(error)
  return {
    valid: false,
    error: `Unable to validate model: ${errorMessage}`,
  }
}

/**
 * Suggest a fallback model for 3P users when the selected model is unavailable.
 */
