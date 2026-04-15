// XAA (Cross-App Access) removed — axiomate does not use Anthropic enterprise OAuth.

export class XaaTokenExchangeError extends Error {
  shouldClearIdToken: boolean
  constructor(message: string, opts?: { shouldClearIdToken?: boolean }) {
    super(message)
    this.name = 'XaaTokenExchangeError'
    this.shouldClearIdToken = opts?.shouldClearIdToken ?? false
  }
}

export type XaaResult = {
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  authorizationServerUrl: string
}

export async function performCrossAppAccess(..._args: unknown[]): Promise<XaaResult> {
  throw new XaaTokenExchangeError('XAA is not available')
}

export async function discoverProtectedResource(..._args: unknown[]): Promise<any> {
  throw new Error('XAA is not available')
}

export async function discoverAuthorizationServer(..._args: unknown[]): Promise<any> {
  throw new Error('XAA is not available')
}

export async function requestJwtAuthorizationGrant(..._args: unknown[]): Promise<any> {
  throw new Error('XAA is not available')
}

export async function exchangeJwtAuthGrant(..._args: unknown[]): Promise<any> {
  throw new Error('XAA is not available')
}
