// Stub: useFrustrationDetection — not available in this build.
export function useFrustrationDetection(
  _messages?: unknown[],
  _isLoading?: boolean,
  _hasActivePrompt?: boolean,
  _isSurveyActive?: boolean,
): {
  state: 'closed' | 'open' | string
  isFrustrated?: boolean
  frustrationScore?: number
  resetDetection?: () => void
} {
  return {
    state: 'closed',
    isFrustrated: false,
    frustrationScore: 0,
    resetDetection() {},
  }
}
