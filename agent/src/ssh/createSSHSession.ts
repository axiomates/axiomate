// Stub: SSH session — type imports from REPL.tsx and useSSHSession.ts.

import type { Tool } from '../Tool.js'

export interface SSHSession {
  connected: boolean
  host: string
  port: number
  proc: {
    exitCode: number | null
    signalCode: string | null
    pid?: number
  }
  proxy: {
    stop(): void
  }
  createManager(opts: {
    onMessage?: (msg: { type?: string; subtype?: string; [key: string]: unknown }) => void
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onPermissionRequest?: (request: any, requestId: string) => void
    onConnected?: () => void
    onReconnecting?: (attempt: number, max: number) => void
    onDisconnected?: () => void
    onError?: (error: Error) => void
  }): {
    connect(): void
    disconnect(): void
    sendMessage(content: unknown): Promise<boolean>
    respondToPermissionRequest(requestId: string, result: unknown): void
    interrupt(): void
  }
  getStderrTail(): string
}

export function findToolByName(
  _tools: Tool[],
  _name: string,
): Tool | undefined {
  return undefined
}

export class SSHSessionError extends Error {
  constructor(message?: string) {
    super(message ?? 'SSH is not available in this build')
    this.name = 'SSHSessionError'
  }
}

export async function createLocalSSHSession(
  ..._args: unknown[]
): Promise<SSHSession | null> {
  return null
}

export async function createSSHSession(
  ..._args: unknown[]
): Promise<SSHSession | null> {
  return null
}
