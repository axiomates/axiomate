/**
 * Protocol-agnostic stream stall detection middleware.
 * Wraps any async iterable to detect and report gaps between events.
 * Reusable across both Anthropic and OpenAI streams.
 */

export interface StallDetectionConfig {
  /** Minimum gap (ms) between events to count as a stall. Default: 30_000 */
  thresholdMs?: number
  /** Called when a stall is detected */
  onStall?: (info: StallInfo) => void
  /** Called when the first event arrives */
  onFirstEvent?: () => void
  /** Called when the stream ends with a summary (only if stalls occurred) */
  onStreamEnd?: (summary: StallSummary) => void
}

export interface StallInfo {
  durationMs: number
  stallCount: number
  totalStallTimeMs: number
}

export interface StallSummary {
  stallCount: number
  totalStallTimeMs: number
}

/**
 * Wraps a stream to detect stalls (gaps between events exceeding threshold).
 * Passes all events through unchanged — purely observational.
 */
export async function* withStallDetection<T>(
  stream: AsyncIterable<T>,
  config: StallDetectionConfig = {},
): AsyncGenerator<T> {
  const thresholdMs = config.thresholdMs ?? 30_000
  let isFirstEvent = true
  let lastEventTime: number | null = null
  let stallCount = 0
  let totalStallTimeMs = 0

  for await (const event of stream) {
    const now = Date.now()

    if (isFirstEvent) {
      config.onFirstEvent?.()
      isFirstEvent = false
    } else if (lastEventTime !== null) {
      const gap = now - lastEventTime
      if (gap > thresholdMs) {
        stallCount++
        totalStallTimeMs += gap
        config.onStall?.({
          durationMs: gap,
          stallCount,
          totalStallTimeMs,
        })
      }
    }

    lastEventTime = now
    yield event
  }

  // Stream ended — report summary if any stalls occurred
  if (stallCount > 0) {
    config.onStreamEnd?.({ stallCount, totalStallTimeMs })
  }
}
