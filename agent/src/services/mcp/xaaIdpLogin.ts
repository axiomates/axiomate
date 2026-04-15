// XAA IdP Login removed — axiomate does not use Anthropic enterprise OAuth.

export type XaaIdpSettings = {
  issuer: string
  clientId: string
  callbackPort?: number
}

export function isXaaEnabled(): boolean {
  return false
}

export function getXaaIdpSettings(): XaaIdpSettings | undefined {
  return undefined
}

export type IdpLoginOptions = {
  idpIssuer: string
  idpClientId: string
  idpClientSecret?: string
  callbackPort?: number
  forceRefresh?: boolean
  onAuthorizationUrl?: (url: string) => void
  skipBrowserOpen?: boolean
  abortSignal?: AbortSignal
}

export function issuerKey(_issuer: string): string {
  return ''
}

export function getCachedIdpIdToken(_idpIssuer: string): string | undefined {
  return undefined
}

export type SaveIdpIdTokenResult = {
  success: boolean
  warning?: string
}

export function saveIdpIdTokenFromJwt(_issuer: string, _jwt: string): number {
  return 0
}

export function clearIdpIdToken(_idpIssuer: string): void {}

export function saveIdpClientSecret(_idpIssuer: string, _secret: string): SaveIdpIdTokenResult {
  return { success: false }
}

export function getIdpClientSecret(_idpIssuer: string): string | undefined {
  return undefined
}

export function clearIdpClientSecret(_idpIssuer: string): void {}

export async function discoverOidc(_issuer: string): Promise<{ token_endpoint: string }> {
  throw new Error('XAA IdP login is not available')
}

export async function acquireIdpIdToken(_options: IdpLoginOptions): Promise<string> {
  throw new Error('XAA IdP login is not available')
}
