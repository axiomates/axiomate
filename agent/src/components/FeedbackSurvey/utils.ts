// Stub: FeedbackSurvey utils — type imports from useSkillImprovementSurvey.ts.

export type FeedbackSurveyResponse = 'dismissed' | 'bad' | 'fine' | 'good'

export type FeedbackSurveyType = 'skill_improvement' | 'frustration' | string

export type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = Record<string, unknown>
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED = Record<string, unknown>

export function logEvent(
  _eventName: string,
  _metadata?: Record<string, unknown>,
): void {
  // no-op
}
