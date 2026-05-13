# axiomate-sdk basics

End-to-end examples for [`axiomate-sdk`](../../packages/sdk).

The SDK is a separate npm library that spawns the `axiomate` CLI as a subprocess and talks to it over NDJSON on stdio. It mirrors the public surface of `@anthropic-ai/claude-agent-sdk` so most snippets from that ecosystem translate directly.

## Setup

This sample is a pnpm workspace member. From the repo root:

```bash
pnpm install
pnpm --filter sdk-basics run build
```

The `axiomate` CLI must be on `PATH` (or set `AXIOMATE_BIN=/path/to/binary`). The samples don't bundle the CLI — they call it the way a real consumer would.

```bash
# Build axiomate first if you haven't already:
pnpm run build:agent
# Then either symlink dist/cli.js onto your PATH or:
export AXIOMATE_BIN=/abs/path/to/axiomate/agent/dist/cli.js
```

## Examples

| Script | What it shows |
|--------|---------------|
| `pnpm run query` | The minimal `query()` loop — spawn the CLI, stream `SDKMessage` events, print the final result. Pass a prompt as `argv[2]`. |
| `pnpm run custom-tool` | `tool()` + `createSdkMcpServer()` — define in-process tools with Zod schemas and let the agent invoke them via the MCP control protocol. |
| `pnpm run sessions` | `listSessions` / `getSessionInfo` / `getSessionMessages` against `~/.axiomate/projects/`. Pass `--mutate` to also demo `forkSession` / `renameSession` / `tagSession`. |
| `pnpm run scheduler` | `watchScheduledTasks()` — watches `<dir>/.axiomate/scheduled_tasks.json`, yields fire/missed events, exposes `getNextFireTime()`. Pass `--seed-recurring` to plant an every-minute task that fires on the next minute boundary. |

Each script is self-contained — read the source under `src/` and copy what you need.

## Notes

- `permissionMode: 'bypassPermissions'` is used in the examples so they can run without an interactive prompter. **Don't** use that in production; supply an `onPermissionRequest` callback or rely on the user's `~/.axiomate/settings.json` rules instead.
- Native capabilities (computer-use, audio, clipboard) are owned by the CLI, not the SDK. Enable them by allow-listing the corresponding tool names — for example `allowedTools: ['mcp__computer-use__screenshot']`. The SDK never loads `.node` modules itself.
- Sessions are stored as JSONL under `~/.axiomate/projects/<sanitized-cwd>/<session-uuid>.jsonl`. The path layout matches the CLI's, so the SDK and CLI can read each other's sessions interchangeably.
