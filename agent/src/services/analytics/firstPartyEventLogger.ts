/**
 * First-party event logger — stub.
 * The OTel pipeline and batch export infrastructure have been removed.
 * All exports are kept as no-ops for interface compatibility.
 */

/** No-op: events are not sent anywhere. */
export function logEventTo1P(
  _eventName: string,
  _metadata: Record<string, number | boolean | undefined> = {},
): void {}

/** Always returns null (no sampling config). */
export function shouldSampleEvent(_eventName: string): number | null {
  return null
}

/** No-op: nothing to initialize. */
export function initialize1PEventLogging(): void {}

/** No-op: nothing to shut down. */
export async function shutdown1PEventLogging(): Promise<void> {}
