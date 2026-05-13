/**
 * Example: basic query() usage.
 *
 * Spawns the axiomate CLI as a subprocess, sends a prompt, streams the
 * agent's messages, and prints the final result.
 *
 * Run:
 *   pnpm run build && pnpm run query
 *
 * Requires the `axiomate` binary on PATH, or set AXIOMATE_BIN=/path/to/binary,
 * or pass `options.cliPath` explicitly.
 */

import { query } from 'axiomate-sdk'

async function main() {
  const userPrompt = process.argv[2] ?? 'List the files in the current directory and tell me what this project is.'

  const q = query({
    prompt: userPrompt,
    options: {
      // Stop after a few turns so the example doesn't run forever.
      maxTurns: 5,
      // Read-only tools only; we don't want this example mutating anything.
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash(ls:*)', 'Bash(cat:*)'],
      // bypass interactive permission prompts — fine for a read-only demo.
      permissionMode: 'bypassPermissions',
      // Forward Ctrl-C → SIGTERM → CLI graceful shutdown
      abortSignal: AbortController.prototype && new AbortController().signal,
    },
  })

  for await (const msg of q) {
    switch (msg.type) {
      case 'system':
        console.log(`[system] init — model=${msg.model}, tools=${msg.tools?.length ?? 0}`)
        break

      case 'assistant': {
        // The assistant's content is a list of blocks (text / tool_use / thinking)
        const blocks = msg.message?.content ?? []
        for (const block of blocks) {
          if (block.type === 'text') {
            process.stdout.write(block.text)
          } else if (block.type === 'tool_use') {
            console.log(`\n[tool_use] ${block.name}(${JSON.stringify(block.input).slice(0, 80)})`)
          }
        }
        break
      }

      case 'user': {
        // User messages here represent tool_result blocks coming back into the loop.
        const content = msg.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              const preview =
                typeof block.content === 'string'
                  ? block.content
                  : JSON.stringify(block.content)
              console.log(`\n[tool_result] ${preview.slice(0, 120)}`)
            }
          }
        }
        break
      }

      case 'result': {
        console.log('\n')
        console.log('─'.repeat(60))
        if (msg.subtype === 'success') {
          console.log(`✓ done in ${msg.duration_ms}ms · turns=${msg.num_turns} · cost=$${msg.total_cost_usd.toFixed(4)}`)
        } else {
          console.log(`✗ ${msg.subtype}: ${msg.errors?.join('; ') ?? 'no detail'}`)
        }
        break
      }

      default:
        // Other event types (status, tool_progress, hook_*, etc.) are ignored
        // here for brevity. Print them if you want to see them.
        break
    }
  }
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
