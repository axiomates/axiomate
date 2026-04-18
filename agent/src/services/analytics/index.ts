/**
 * Analytics service - public API for event logging.
 *
 * Axiomate does not ship a hosted analytics backend. Events are forwarded to
 * the optional OpenTelemetry pipeline only when the user explicitly enables it
 * with telemetry environment variables.
 */

import { isEnvTruthy } from '../../utils/envUtils.js'
import { isTelemetryDisabled } from '../../utils/privacyLevel.js'

/**
 * Marker type for verifying analytics metadata doesn't contain sensitive data
 *
 * This type forces explicit verification that string values being logged
 * don't contain code snippets, file paths, or other sensitive information.
 *
 * Usage: `myString as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`
 */
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = never

/**
 * Marker type for values routed to PII-tagged proto columns via `_PROTO_*`
 * payload keys.
 */
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED = never

/**
 * Strip `_PROTO_*` keys from a payload destined for general-access storage.
 * Returns the input unchanged (same reference) when no _PROTO_ keys present.
 */
export function stripProtoFields<V>(
  metadata: Record<string, V>,
): Record<string, V> {
  let result: Record<string, V> | undefined
  for (const key in metadata) {
    if (key.startsWith('_PROTO_')) {
      if (result === undefined) {
        result = { ...metadata }
      }
      delete result[key]
    }
  }
  return result ?? metadata
}

// Internal type for logEvent metadata.
type LogEventMetadata = {
  [key: string]: boolean | number | string | undefined
}

function isAnalyticsPipelineEnabled(): boolean {
  if (process.env.NODE_ENV === 'test' || isTelemetryDisabled()) {
    return false
  }

  return (
    isEnvTruthy(process.env.AXIOMATE_CODE_ENABLE_TELEMETRY) ||
    (isEnvTruthy(process.env.ENABLE_BETA_TRACING_DETAILED) &&
      Boolean(process.env.BETA_TRACING_ENDPOINT))
  )
}

function toOtelMetadata(
  metadata: LogEventMetadata,
): { [key: string]: string | undefined } {
  const stripped = stripProtoFields(metadata)
  const result: { [key: string]: string | undefined } = {}

  for (const [key, value] of Object.entries(stripped)) {
    if (value !== undefined) {
      result[key] = String(value)
    }
  }

  return result
}

async function emitOtelEvent(
  eventName: string,
  metadata: LogEventMetadata,
): Promise<void> {
  if (!isAnalyticsPipelineEnabled()) {
    return
  }

  try {
    const { logOTelEvent } = await import('../../utils/telemetry/events.js')
    await logOTelEvent(eventName, toOtelMetadata(metadata))
  } catch {
    // Analytics must never affect product behavior.
  }
}

/**
 * Log an event to the configured analytics pipeline.
 */
export function logEvent(
  eventName: string,
  metadata: LogEventMetadata,
): void {
  void emitOtelEvent(eventName, metadata)
}

/**
 * Log an event to the configured analytics pipeline asynchronously.
 */
export async function logEventAsync(
  eventName: string,
  metadata: LogEventMetadata,
): Promise<void> {
  await emitOtelEvent(eventName, metadata)
}

/**
 * Reset analytics state for testing purposes only.
 * @internal
 */
export function _resetForTesting(): void {}
