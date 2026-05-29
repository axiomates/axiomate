import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { platform } from 'node:os'
import type { Options } from './types/index.js'

export type SubprocessHandle = {
  process: ChildProcess
  stdin: Writable
  stdout: Readable
  stderr: Readable
  kill(): void
}

function findBinary(cliPath?: string): string {
  if (cliPath) return cliPath

  const envPath = process.env['AXIOMATE_BIN']
  if (envPath) return envPath

  const isWindows = platform() === 'win32'
  return isWindows ? 'axiomate.exe' : 'axiomate'
}

export function buildCliArgs(options: Options, prompt?: string): string[] {
  const args: string[] = []

  args.push('--print')

  if (prompt) {
    // Note: with --input-format stream-json, prompts go via stdin NDJSON.
    // This branch is only used for the deprecated single-prompt-via-arg path.
    args.push(prompt)
  }

  args.push('--output-format', 'stream-json')
  args.push('--input-format', 'stream-json')
  args.push('--verbose')

  if (options.model) args.push('--model', options.model)
  if (options.effort) args.push('--effort', options.effort)
  if (options.agent) args.push('--agent', options.agent)
  if (options.name) args.push('--name', options.name)

  if (options.systemPrompt) args.push('--system-prompt', options.systemPrompt)
  if (options.systemPromptFile) args.push('--system-prompt-file', options.systemPromptFile)
  if (options.appendSystemPrompt) args.push('--append-system-prompt', options.appendSystemPrompt)
  if (options.appendSystemPromptFile) {
    args.push('--append-system-prompt-file', options.appendSystemPromptFile)
  }

  if (options.maxTurns != null) args.push('--max-turns', String(options.maxTurns))
  if (options.maxBudgetUsd != null) args.push('--max-budget-usd', String(options.maxBudgetUsd))
  if (options.taskBudget != null) args.push('--task-budget', String(options.taskBudget))

  if (options.thinkingConfig) {
    args.push('--thinking', options.thinkingConfig.type)
    if ('budgetTokens' in options.thinkingConfig && options.thinkingConfig.budgetTokens != null) {
      args.push('--max-thinking-tokens', String(options.thinkingConfig.budgetTokens))
    }
  } else if (options.maxThinkingTokens != null) {
    args.push('--max-thinking-tokens', String(options.maxThinkingTokens))
  }

  if (options.jsonSchema) {
    args.push('--json-schema', JSON.stringify(options.jsonSchema))
  }

  if (options.verbose === false) {
    // already added --verbose above; leave as default since CLI requires it for stream-json
  }

  if (options.resume) {
    if (typeof options.resume === 'string') {
      args.push('--resume', options.resume)
    } else {
      args.push('--resume')
    }
  }
  if (options.continue) args.push('--continue')
  if (options.forkSession) args.push('--fork-session')
  if (options.persistSession === false) args.push('--no-session-persistence')
  if (options.sessionId) args.push('--session-id', options.sessionId)
  if (options.resumeSessionAt) args.push('--resume-session-at', options.resumeSessionAt)
  if (options.rewindFiles) args.push('--rewind-files', options.rewindFiles)
  if (options.replayUserMessages) args.push('--replay-user-messages')
  if (options.includePartialMessages) args.push('--include-partial-messages')
  if (options.includeHookEvents) args.push('--include-hook-events')

  // Variadic flags: pass all values after a single flag occurrence
  if (options.allowedTools?.length) {
    args.push('--allowed-tools', ...options.allowedTools)
  }
  if (options.disallowedTools?.length) {
    args.push('--disallowed-tools', ...options.disallowedTools)
  }
  if (options.tools !== undefined) {
    if (typeof options.tools === 'string') {
      args.push('--tools', options.tools)
    } else if (options.tools.length) {
      args.push('--tools', ...options.tools)
    }
  }

  if (options.dangerouslySkipPermissions) {
    args.push('--dangerously-skip-permissions')
  } else if (options.permissionMode && options.permissionMode !== 'default') {
    args.push('--permission-mode', options.permissionMode)
  }
  if (options.permissionPromptTool) {
    args.push('--permission-prompt-tool', options.permissionPromptTool)
  }

  if (options.mcpConfig?.length) {
    args.push('--mcp-config', ...options.mcpConfig)
  }
  if (options.strictMcpConfig) args.push('--strict-mcp-config')

  if (options.settings) args.push('--settings', options.settings)
  if (options.settingSources?.length) {
    args.push('--setting-sources', options.settingSources.join(','))
  }
  if (options.addDirs?.length) args.push('--add-dir', ...options.addDirs)

  // Repeatable single-value flag
  if (options.pluginDirs?.length) {
    for (const dir of options.pluginDirs) {
      args.push('--plugin-dir', dir)
    }
  }

  if (options.disableSlashCommands) args.push('--disable-slash-commands')

  if (options.betas?.length) args.push('--betas', ...options.betas)
  if (options.workload) args.push('--workload', options.workload)

  if (options.agentsJson) {
    args.push('--agents', options.agentsJson)
  } else if (options.agents) {
    args.push('--agents', JSON.stringify(options.agents))
  }

  if (options.ide) args.push('--ide')
  if (options.bare) args.push('--bare')

  return args
}

export function spawnAxiomate(options: Options): SubprocessHandle {
  const binary = findBinary(options.cliPath)
  const args = buildCliArgs(options)

  const child = spawn(binary, args, {
    cwd: options.cwd || process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  })

  const kill = () => {
    if (!child.killed) {
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
      }, 5000)
    }
  }

  if (options.abortSignal) {
    options.abortSignal.addEventListener('abort', kill, { once: true })
  }

  return {
    process: child,
    stdin: child.stdin!,
    stdout: child.stdout!,
    stderr: child.stderr!,
    kill,
  }
}
