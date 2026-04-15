import React, { useEffect } from 'react'

export interface PreflightCheckResult {
  success: boolean
  error?: string
  sslHint?: string
}

interface PreflightStepProps {
  onSuccess: () => void
}

export function PreflightStep({
  onSuccess,
}: PreflightStepProps): React.ReactNode {
  useEffect(() => {
    // Axiomate doesn't connect to the API endpoint, skip health checks
    onSuccess()
  }, [onSuccess])

  return null
}
