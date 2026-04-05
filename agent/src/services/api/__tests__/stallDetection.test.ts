import { describe, it, expect, vi } from 'vitest'
import {
  withStallDetection,
  type StallDetectionConfig,
} from '../middleware/stallDetection.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* mockStream<T>(items: T[], delayMs?: number[]): AsyncGenerator<T> {
  for (let i = 0; i < items.length; i++) {
    if (delayMs && delayMs[i]) {
      await new Promise(r => setTimeout(r, delayMs[i]))
    }
    yield items[i]
  }
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of gen) result.push(item)
  return result
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('withStallDetection', () => {
  it('passes all events through unchanged', async () => {
    const events = ['a', 'b', 'c']
    const result = await collect(withStallDetection(mockStream(events)))
    expect(result).toEqual(events)
  })

  it('calls onFirstEvent on the first event', async () => {
    const onFirstEvent = vi.fn()
    await collect(withStallDetection(mockStream(['x']), { onFirstEvent }))
    expect(onFirstEvent).toHaveBeenCalledTimes(1)
  })

  it('does not call onFirstEvent for empty stream', async () => {
    const onFirstEvent = vi.fn()
    await collect(withStallDetection(mockStream([]), { onFirstEvent }))
    expect(onFirstEvent).not.toHaveBeenCalled()
  })

  it('detects stalls when gap exceeds threshold', async () => {
    const onStall = vi.fn()
    // Use a very low threshold so we can trigger with a small delay
    const events = [1, 2, 3]
    const delays = [0, 50, 0] // 50ms gap between event 1 and 2
    await collect(
      withStallDetection(mockStream(events, delays), {
        thresholdMs: 20, // 20ms threshold
        onStall,
      }),
    )
    expect(onStall).toHaveBeenCalledTimes(1)
    expect(onStall.mock.calls[0][0].stallCount).toBe(1)
    expect(onStall.mock.calls[0][0].durationMs).toBeGreaterThanOrEqual(20)
  })

  it('does not trigger for gaps below threshold', async () => {
    const onStall = vi.fn()
    const events = [1, 2, 3]
    const delays = [0, 5, 5] // small gaps
    await collect(
      withStallDetection(mockStream(events, delays), {
        thresholdMs: 100,
        onStall,
      }),
    )
    expect(onStall).not.toHaveBeenCalled()
  })

  it('calls onStreamEnd with summary when stalls occurred', async () => {
    const onStreamEnd = vi.fn()
    const events = [1, 2]
    const delays = [0, 50]
    await collect(
      withStallDetection(mockStream(events, delays), {
        thresholdMs: 20,
        onStreamEnd,
      }),
    )
    expect(onStreamEnd).toHaveBeenCalledTimes(1)
    expect(onStreamEnd.mock.calls[0][0].stallCount).toBe(1)
  })

  it('does not call onStreamEnd when no stalls occurred', async () => {
    const onStreamEnd = vi.fn()
    await collect(
      withStallDetection(mockStream([1, 2, 3]), {
        thresholdMs: 100000,
        onStreamEnd,
      }),
    )
    expect(onStreamEnd).not.toHaveBeenCalled()
  })

  it('accumulates multiple stalls', async () => {
    const onStall = vi.fn()
    const onStreamEnd = vi.fn()
    const events = [1, 2, 3]
    const delays = [0, 50, 50] // two gaps
    await collect(
      withStallDetection(mockStream(events, delays), {
        thresholdMs: 20,
        onStall,
        onStreamEnd,
      }),
    )
    expect(onStall).toHaveBeenCalledTimes(2)
    expect(onStreamEnd.mock.calls[0][0].stallCount).toBe(2)
  })

  it('uses default 30s threshold', async () => {
    const onStall = vi.fn()
    // No delay at all, default threshold is 30s — no stalls
    await collect(withStallDetection(mockStream([1, 2, 3]), { onStall }))
    expect(onStall).not.toHaveBeenCalled()
  })
})
