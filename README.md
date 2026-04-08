# Axiomate

Terminal AI agent with multi-provider support. Fork of Claude Code, rewired to work with any OpenAI-compatible or Anthropic-compatible API endpoint.

Use any model from any provider — SiliconFlow, OpenRouter, local ollama, vLLM, etc. No Anthropic account required.

## Prerequisites

- [Bun](https://bun.sh/) >= 1.1
- [Rust](https://rustup.rs/) toolchain (for native audio capture module)
- Git

## Quick Start

```bash
git clone https://github.com/axiomates/axiomate.git
cd axiomate
bun install

cd agent
bun run build
bun dist/cli.js
```

## Configuration

Models are configured in `~/.axiomate.json`. On first run the file is created automatically — add your models to it:

```jsonc
{
  "models": {
    "qwen/qwen3-235b": {
      "model": "qwen/qwen3-235b",
      "name": "Qwen3 235B",
      "protocol": "openai",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "sk-...",
      "contextWindow": 131072,
      "maxOutputTokens": 32768,
      "thinkingParams": {
        "enable_thinking": true,
        "thinking_budget": 8192
      }
    }
  },
  "currentModel": "qwen/qwen3-235b",
  "fastModel": "qwen/qwen3-235b",
  "midModel": "qwen/qwen3-235b"
}
```

### Model Config Fields

| Field | Required | Description |
|-------|----------|-------------|
| `model` | yes | Model ID sent to the provider API |
| `name` | no | Display name in the model picker |
| `protocol` | yes | `"openai"` or `"anthropic"` — determines SDK used |
| `baseUrl` | yes | API endpoint URL |
| `apiKey` | yes | API key for authentication |
| `contextWindow` | no | Context window size in tokens |
| `maxOutputTokens` | no | Max output tokens per response |
| `supportsImages` | no | Whether the model supports image/vision input. Defaults to `true`. Set to `false` for text-only models to avoid API errors |
| `thinkingParams` | no | Vendor-specific thinking/reasoning params, merged into request when thinking is enabled |
| `extraParams` | no | Extra params merged into every API request body (passthrough) |

### Protocol

- `"openai"` — OpenAI-compatible APIs (OpenRouter, SiliconFlow, vLLM, ollama, etc.)
- `"anthropic"` — Anthropic-compatible APIs (Anthropic direct, or providers implementing the Anthropic messages format)

### Multi-Model Setup

- `currentModel` — main model for the conversation loop
- `fastModel` — cheap/fast model for lightweight tasks (token estimation, session search). Falls back to `currentModel`
- `midModel` — mid-tier model for reasoning tasks (memory selection, classification). Falls back to `currentModel`

All three are keys into the `models` map. If only `currentModel` is set, it's used for everything.

## Project Structure

```
axiomate/
  agent/                          Main CLI application
    src/entrypoints/cli.tsx       CLI entry point
    src/services/api/             Provider registry, OpenAI/Anthropic providers
    src/utils/model/              Model selection logic
    src/utils/config.ts           Configuration types and loading
    build.ts                      Dev build script (bundle only)
    package-win.ts                Windows exe packaging script
  clipboard-axiomate/             Clipboard access (Rust NAPI + PowerShell/xclip fallback)
  audio-capture-axiomate/         Audio recording (Rust NAPI, cpal)
  image-processor-axiomate/       Image processing (sharp wrapper)
  computer-use-native-axiomate/   Mouse/keyboard/screenshot (nut-js, node-screenshots)
  computer-use-mcp-axiomate/      Computer use MCP server
  sandbox-axiomate/               Sandbox execution
  treeify-axiomate/               Directory tree display
  mcpb-axiomate/                  MCP bridge
  chrome-mcp-axiomate/            Chrome MCP integration
```

## Build

### Development

Bundles source into a single JS file. Requires `node_modules` at runtime.

```bash
cd agent
bun run build        # → dist/cli.js
bun dist/cli.js      # run
```

### Tests

```bash
cd agent
bun run test
```

### Windows Standalone Exe

Compiles everything into a standalone `axiomate.exe` + native addon files. No Bun or node_modules needed to run.

**Additional prerequisite:** Rust with `x86_64-pc-windows-msvc` target.

```bash
cd agent
bun run package:win
```

Output in `agent/dist/`:

```
axiomate.exe                              ~137 MB  (Bun runtime + all JS)
sharp-win32-x64.node                      image processing
libnut.node                               mouse/keyboard control
node-screenshots.win32-x64-msvc.node      screenshots
audio-capture-axiomate.node               audio recording
```

All files must stay in the same directory. To distribute, copy the entire `dist/` folder.

#### What `package:win` does

1. Compiles `clipboard-axiomate` TypeScript (PowerShell fallback for Windows clipboard)
2. Compiles `audio-capture-axiomate` Rust NAPI (native audio recording via cpal)
3. Bundles all ~6800 JS modules into a single file via `Bun.build()`
4. Compiles the bundle into `axiomate.exe` via `bun build --compile`
5. Copies native `.node` files alongside the exe

## License

MIT
