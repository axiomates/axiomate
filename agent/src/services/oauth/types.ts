// Stub: OAuth types — type imports from auth.ts, config.ts, etc.

export interface OAuthTokens {
  accessToken: string
  refreshToken?: string | null
  expiresAt?: number | null
  scopes?: string[]
  subscriptionType?: string | null
  rateLimitTier?: string | null
  profile?: OAuthProfileResponse | null
  tokenAccount?: {
    uuid: string
    emailAddress: string
    organizationUuid: string
  } | null
  [key: string]: unknown
}

export interface ReferralRedemptionsResponse {
  redemptions: unknown[]
  limit?: number
  [key: string]: unknown
}

export interface ReferrerRewardInfo {
  referralCode?: string
  rewardsEarned?: number
  currency?: string
  amount_minor_units?: number
  [key: string]: unknown
}

export type SubscriptionType = 'free' | 'pro' | 'team' | 'enterprise' | 'max' | string

export interface OAuthProfileResponse {
  account: {
    uuid: string
    email: string
    display_name?: string
    created_at?: string
    has_claude_max?: boolean
    has_claude_pro?: boolean
    [key: string]: unknown
  }
  organization: {
    uuid: string
    organization_type?: string
    rate_limit_tier?: string
    has_extra_usage_enabled?: boolean
    billing_type?: string
    subscription_created_at?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export type BillingType = string

export interface ReferralEligibilityResponse {
  eligible: boolean
  remaining_passes?: number
  referral_code_details?: {
    referral_link?: string
    campaign?: string
    [key: string]: unknown
  }
  referrer_reward?: ReferrerRewardInfo | null
  [key: string]: unknown
}

export type ReferralCampaign = string

export interface OAuthTokenExchangeResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  scope?: string
  account?: {
    uuid: string
    email_address?: string
    [key: string]: unknown
  }
  organization?: {
    uuid?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export type RateLimitTier = 'free' | 'paid' | 'enterprise' | string

export interface UserRolesResponse {
  roles: string[]
  organization_role?: string
  workspace_role?: string
  organization_name?: string
  [key: string]: unknown
}

export function setMockBillingAccessOverride(_value: boolean | null): void {
  // no-op
}

export function getAnthropicApiKey(): string | null {
  return null
}

export function getApiKeyFromFileDescriptor(): string | null {
  return null
}

export function getOAuthTokenFromFileDescriptor(): string | null {
  return null
}

export function getCwd(): string {
  return process.cwd()
}
