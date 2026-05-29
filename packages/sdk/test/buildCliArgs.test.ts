import { describe, it, expect } from 'vitest'
import { buildCliArgs } from '../src/subprocess.js'

describe('buildCliArgs', () => {
  it('always sets --print --output-format stream-json --input-format stream-json --verbose', () => {
    const args = buildCliArgs({})
    expect(args).toContain('--print')
    expect(args).toContain('--output-format')
    expect(args).toContain('stream-json')
    expect(args).toContain('--input-format')
    expect(args).toContain('--verbose')
  })

  it('passes model', () => {
    const args = buildCliArgs({ model: 'opus-4.7' })
    expect(args).toEqual(expect.arrayContaining(['--model', 'opus-4.7']))
  })

  it('passes effort level', () => {
    const args = buildCliArgs({ effort: 'high' })
    expect(args).toEqual(expect.arrayContaining(['--effort', 'high']))
  })

  it('passes agent name and display name', () => {
    const args = buildCliArgs({ agent: 'reviewer', name: 'My Session' })
    expect(args).toEqual(expect.arrayContaining(['--agent', 'reviewer']))
    expect(args).toEqual(expect.arrayContaining(['--name', 'My Session']))
  })

  it('passes system prompts and file variants', () => {
    const args = buildCliArgs({
      systemPrompt: 'You are X',
      appendSystemPrompt: 'Be Y',
      systemPromptFile: '/tmp/sys.txt',
      appendSystemPromptFile: '/tmp/append.txt',
    })
    expect(args).toEqual(expect.arrayContaining(['--system-prompt', 'You are X']))
    expect(args).toEqual(expect.arrayContaining(['--append-system-prompt', 'Be Y']))
    expect(args).toEqual(expect.arrayContaining(['--system-prompt-file', '/tmp/sys.txt']))
    expect(args).toEqual(expect.arrayContaining(['--append-system-prompt-file', '/tmp/append.txt']))
  })

  it('passes budgets', () => {
    const args = buildCliArgs({ maxTurns: 5, maxBudgetUsd: 1.5, taskBudget: 100000 })
    expect(args).toEqual(expect.arrayContaining(['--max-turns', '5']))
    expect(args).toEqual(expect.arrayContaining(['--max-budget-usd', '1.5']))
    expect(args).toEqual(expect.arrayContaining(['--task-budget', '100000']))
  })

  it('serializes thinking config', () => {
    const args = buildCliArgs({ thinkingConfig: { type: 'enabled', budgetTokens: 8000 } })
    expect(args).toEqual(expect.arrayContaining(['--thinking', 'enabled']))
    expect(args).toEqual(expect.arrayContaining(['--max-thinking-tokens', '8000']))
  })

  it('uses --no-session-persistence when persistSession=false', () => {
    expect(buildCliArgs({ persistSession: false })).toContain('--no-session-persistence')
    expect(buildCliArgs({ persistSession: true })).not.toContain('--no-session-persistence')
  })

  it('passes resume variants', () => {
    expect(buildCliArgs({ resume: true })).toContain('--resume')
    const withId = buildCliArgs({ resume: 'session-uuid' })
    expect(withId).toEqual(expect.arrayContaining(['--resume', 'session-uuid']))
  })

  it('uses variadic args for allowedTools/disallowedTools (single flag, multiple values)', () => {
    const args = buildCliArgs({
      allowedTools: ['Bash(git:*)', 'Edit'],
      disallowedTools: ['Bash(rm:*)'],
    })
    expect(args.filter((a) => a === '--allowed-tools')).toHaveLength(1)
    expect(args.filter((a) => a === '--disallowed-tools')).toHaveLength(1)
    expect(args).toEqual(expect.arrayContaining(['--allowed-tools', 'Bash(git:*)', 'Edit']))
    expect(args).toEqual(expect.arrayContaining(['--disallowed-tools', 'Bash(rm:*)']))
  })

  it('passes --tools "" (disable all) and "default"', () => {
    expect(buildCliArgs({ tools: '' })).toEqual(expect.arrayContaining(['--tools', '']))
    expect(buildCliArgs({ tools: 'default' })).toEqual(expect.arrayContaining(['--tools', 'default']))
    expect(buildCliArgs({ tools: ['Bash', 'Edit'] })).toEqual(
      expect.arrayContaining(['--tools', 'Bash', 'Edit']),
    )
  })

  it('dangerouslySkipPermissions takes precedence over permissionMode', () => {
    const args = buildCliArgs({
      dangerouslySkipPermissions: true,
      permissionMode: 'plan',
    })
    expect(args).toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('--permission-mode')
  })

  it('serializes mcpConfig as variadic', () => {
    const args = buildCliArgs({ mcpConfig: ['/path/a.json', '{"foo":"bar"}'] })
    expect(args.filter((a) => a === '--mcp-config')).toHaveLength(1)
    expect(args).toEqual(expect.arrayContaining(['--mcp-config', '/path/a.json', '{"foo":"bar"}']))
  })

  it('passes strictMcpConfig flag', () => {
    expect(buildCliArgs({ strictMcpConfig: true })).toContain('--strict-mcp-config')
  })

  it('passes settings and settingSources', () => {
    const args = buildCliArgs({ settings: '/tmp/s.json', settingSources: ['user', 'project'] })
    expect(args).toEqual(expect.arrayContaining(['--settings', '/tmp/s.json']))
    expect(args).toEqual(expect.arrayContaining(['--setting-sources', 'user,project']))
  })

  it('passes addDirs as variadic and pluginDirs as repeatable', () => {
    const args = buildCliArgs({
      addDirs: ['/a', '/b'],
      pluginDirs: ['/p1', '/p2'],
    })
    expect(args.filter((a) => a === '--add-dir')).toHaveLength(1)
    expect(args.filter((a) => a === '--plugin-dir')).toHaveLength(2)
    expect(args).toEqual(expect.arrayContaining(['--add-dir', '/a', '/b']))
    expect(args).toEqual(expect.arrayContaining(['--plugin-dir', '/p1']))
    expect(args).toEqual(expect.arrayContaining(['--plugin-dir', '/p2']))
  })

  it('passes betas variadic', () => {
    const args = buildCliArgs({ betas: ['extended-cache-ttl-2025', 'context-1m'] })
    expect(args).toEqual(expect.arrayContaining(['--betas', 'extended-cache-ttl-2025', 'context-1m']))
  })

  it('serializes agents object as JSON', () => {
    const args = buildCliArgs({
      agents: {
        reviewer: { agentType: 'reviewer', whenToUse: 'Code review' },
      },
    })
    const idx = args.indexOf('--agents')
    expect(idx).toBeGreaterThanOrEqual(0)
    const parsed = JSON.parse(args[idx + 1]!)
    expect(parsed.reviewer.agentType).toBe('reviewer')
  })

  it('agentsJson overrides agents object', () => {
    const args = buildCliArgs({
      agents: { x: { agentType: 'x', whenToUse: 'x' } },
      agentsJson: '{"raw":"json"}',
    })
    expect(args).toEqual(expect.arrayContaining(['--agents', '{"raw":"json"}']))
  })

  it('passes session id and rewind/resume position', () => {
    const args = buildCliArgs({
      sessionId: 'abc-123',
      resumeSessionAt: 'msg-uuid',
      rewindFiles: 'msg-uuid',
    })
    expect(args).toEqual(expect.arrayContaining(['--session-id', 'abc-123']))
    expect(args).toEqual(expect.arrayContaining(['--resume-session-at', 'msg-uuid']))
    expect(args).toEqual(expect.arrayContaining(['--rewind-files', 'msg-uuid']))
  })

  it('passes flag-only booleans', () => {
    const args = buildCliArgs({
      forkSession: true,
      continue: true,
      replayUserMessages: true,
      includePartialMessages: true,
      includeHookEvents: true,
      disableSlashCommands: true,
      ide: true,
      bare: true,
    })
    expect(args).toContain('--fork-session')
    expect(args).toContain('--continue')
    expect(args).toContain('--replay-user-messages')
    expect(args).toContain('--include-partial-messages')
    expect(args).toContain('--include-hook-events')
    expect(args).toContain('--disable-slash-commands')
    expect(args).toContain('--ide')
    expect(args).toContain('--bare')
  })

  it('passes workload tag and permission-prompt-tool', () => {
    const args = buildCliArgs({ workload: 'cron-job', permissionPromptTool: 'my-prompt' })
    expect(args).toEqual(expect.arrayContaining(['--workload', 'cron-job']))
    expect(args).toEqual(expect.arrayContaining(['--permission-prompt-tool', 'my-prompt']))
  })

  it('serializes jsonSchema as a JSON string', () => {
    const args = buildCliArgs({ jsonSchema: { type: 'object', properties: { n: { type: 'string' } } } })
    const idx = args.indexOf('--json-schema')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(JSON.parse(args[idx + 1]!)).toEqual({
      type: 'object',
      properties: { n: { type: 'string' } },
    })
  })
})
