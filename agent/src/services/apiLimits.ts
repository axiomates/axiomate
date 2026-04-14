// Stub — Anthropic rate limit infrastructure removed.
export type ClaudeAILimits = { status: string; isUsingOverage: boolean }
export type OverageDisabledReason = 'not_subscriber' | 'not_supported' | 'org_disabled'
export const currentLimits = { status: 'allowed' as const, isUsingOverage: false }
export const statusListeners = new Set<() => void>()
export function extractQuotaStatusFromHeaders(_headers: unknown): void {}
export function extractQuotaStatusFromError(_error: unknown): void {}
export async function checkQuotaStatus(): Promise<void> {}
export function getRawUtilization(): undefined { return undefined }
export function getRateLimitErrorMessage(): null { return null }
export function getUsingOverageText(): null { return null }
