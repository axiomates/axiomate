// Stub: secureStorage types — imported by services/mcp/auth.ts, etc.

export interface OAuthDiscoveryState {
  authorizationServerUrl?: string
  resourceMetadataUrl?: string
  [key: string]: unknown
}

export interface McpOAuthEntry {
  accessToken?: string
  refreshToken?: string
  clientId?: string
  clientSecret?: string
  expiresAt?: number
  scope?: string
  stepUpScope?: string
  discoveryState?: OAuthDiscoveryState
  codeVerifier?: string
  [key: string]: unknown
}

export interface SecureStorageData {
  mcpOAuth?: Record<string, McpOAuthEntry>
  mcpOAuthClientConfig?: Record<string, { clientSecret?: string; [key: string]: unknown }>
  [key: string]: unknown
}

export interface SecureStorage {
  name?: string
  read(): SecureStorageData | null
  readAsync(): Promise<SecureStorageData | null>
  update(data: SecureStorageData): { success: boolean; warning?: string }
  delete(key?: string): boolean
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
