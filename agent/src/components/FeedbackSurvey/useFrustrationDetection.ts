// Stub: useFrustrationDetection — not available in this build.
export function useFrustrationDetection(
  _messages?: unknown[],
  _isLoading?: boolean,
  _hasActivePrompt?: boolean,
  _isSurveyActive?: boolean,
): {
  state: 'closed' | 'open' | string
  handleTranscriptSelect: (...args: unknown[]) => void
  isFrustrated?: boolean
  frustrationScore?: number
  resetDetection?: () => void
} {
  return {
    state: 'closed',
    handleTranscriptSelect() {},
    isFrustrated: false,
    frustrationScore: 0,
    resetDetection() {},
  }
}
