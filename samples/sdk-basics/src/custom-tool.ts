/**
 * Example: defining custom tools via tool() + createSdkMcpServer().
 *
 * Defines two in-process tools (an "add" calculator and a "current_time"
 * accessor), bundles them into an SDK MCP server, and wires it into
 * query() via options.mcpServers.
 *
 * When the agent invokes one of these tools, the CLI sends an
 * mcp_message control request, the SDK routes it to your handler, and
 * the result flows back into the conversation as a tool_result.
 *
 * Run:
 *   pnpm run build && pnpm run custom-tool
 */

import { query, tool, createSdkMcpServer } from 'axiomate-sdk'
import { z } from 'zod'

// 1. Define tools. Input schemas use Zod raw shapes (not z.object()) —
//    the SDK wraps them at registration time and converts to JSON Schema
//    for the agent.
const addTool = tool(
  'add',
  'Adds two numbers and returns their sum.',
  { a: z.number().describe('First number'), b: z.number().describe('Second number') },
  async ({ a, b }) => ({
    content: [{ type: 'text', text: `The sum is ${a + b}.` }],
  }),
)

const currentTimeTool = tool(
  'current_time',
  'Returns the current local time as an ISO-8601 string.',
  {},
  async () => ({
    content: [{ type: 'text', text: new Date().toISOString() }],
  }),
  {
    // alwaysLoad: true forces the tool into the system prompt every turn
    // instead of going through search. Use sparingly — it consumes context.
    alwaysLoad: true,
  },
)

// 2. Bundle the tools into an in-process MCP server. The server name
//    becomes the prefix the agent sees: mcp__calc__add, mcp__calc__current_time.
const calcServer = createSdkMcpServer({
  name: 'calc',
  version: '1.0.0',
  tools: [addTool, currentTimeTool],
})

async function main() {
  const q = query({
    prompt:
      'What is 17 + 25? Also, what is the current local time? Use the provided tools.',
    options: {
      maxTurns: 5,
      mcpServers: { calc: calcServer },
      // Allow only our SDK tools — the agent shouldn't be reading the filesystem here.
      allowedTools: ['mcp__calc__add', 'mcp__calc__current_time'],
      permissionMode: 'bypassPermissions',
    },
  })

  for await (const msg of q) {
    if (msg.type === 'assistant') {
      const blocks = msg.message?.content ?? []
      for (const block of blocks) {
        if (block.type === 'text') {
          process.stdout.write(block.text)
        } else if (block.type === 'tool_use') {
          console.log(`\n→ ${block.name}(${JSON.stringify(block.input)})`)
        }
      }
    } else if (msg.type === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          const text =
            typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content)
          console.log(`← ${text}`)
        }
      }
    } else if (msg.type === 'result') {
      console.log('\n')
      if (msg.subtype === 'success') {
        console.log(`✓ done · ${msg.num_turns} turns · $${msg.total_cost_usd.toFixed(4)}`)
      } else {
        console.log(`✗ ${msg.subtype}`)
      }
    }
  }
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
