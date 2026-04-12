import { useEffect } from 'react'
import { saveCurrentSessionCosts } from './cost-tracker.js'
import type { FpsMetrics } from './utils/fpsTracker.js'

export function useSessionMetricsPersistence(
  getFpsMetrics?: () => FpsMetrics | undefined,
): void {
  useEffect(() => {
    const f = () => {
      saveCurrentSessionCosts(getFpsMetrics?.())
    }
    process.on('exit', f)
    return () => {
      process.off('exit', f)
    }
  }, [])
}
