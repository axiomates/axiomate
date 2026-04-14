// Stub types — OAuth infrastructure removed. These types are kept as stubs
// to satisfy imports from files not yet cleaned up.
export type OAuthTokens = {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  scope?: string
}
export type SubscriptionType = 'max' | 'pro' | 'team' | 'enterprise' | null
export type BillingType = string
export type ReferralEligibilityResponse = unknown
