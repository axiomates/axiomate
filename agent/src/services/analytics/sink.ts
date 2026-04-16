/**
 * Analytics sink — stub implementation.
 * All analytics backends have been removed.
 * The sink is kept for interface compatibility but does nothing.
 */

import { attachAnalyticsSink } from './index.js'

type LogEventMetadata = { [key: string]: boolean | number | undefined }

function logEventImpl(_eventName: string, _metadata: LogEventMetadata): void {}

function logEventAsyncImpl(
  _eventName: string,
  _metadata: LogEventMetadata,
): Promise<void> {
  return Promise.resolve()
}

export function initializeAnalyticsGates(): void {}

export function initializeAnalyticsSink(): void {
  attachAnalyticsSink({
    logEvent: logEventImpl,
    logEventAsync: logEventAsyncImpl,
  })
}
