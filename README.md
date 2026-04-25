# Axiomate

Terminal AI agent with multi-provider support, built to work with any OpenAI-compatible or Anthropic-compatible API endpoint.

Use any model from any provider — SiliconFlow, OpenRouter, local ollama, vLLM, etc. No Anthropic account required.

## Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/) — required package manager. Install with:
  ```bash
  npm install -g pnpm
  ```
- Git

The bootstrap script will auto-install Bun and Rust when missing (you don't need to install them by hand), but pnpm itself you do need to bring up first because the `pnpm` command has to exist before any `pnpm bootstrap` invocation. Alternative: `npm run bootstrap` or `node scripts/bootstrap.mjs` — those entry points also work and bootstrap will install pnpm itself the first time.

The repo uses pnpm workspaces. Bun is used by the build/runtime scripts, not as the primary installer.

(npm was the previous package manager but is no longer used: it has a long-standing optionalDependencies + workspace bug that drops platform-specific native bindings — see https://github.com/npm/cli/issues/4828)

## Quick Start

```bash
git clone https://github.com/axiomates/axiomate.git
cd axiomate

# First time only: install pnpm if you don't have it
npm install -g pnpm

pnpm bootstrap   # one-shot: install Bun/Rust, install deps, build everything
pnpm start
```

### Automated Environment Setup

The bootstrap script works on macOS, Windows, and Linux. It checks Node/pnpm/Git, installs Bun, pnpm, and Rust when missing, runs `pnpm install`, builds workspace packages, and builds the agent.

```bash
pnpm doctor              # check only, do not install or build
pnpm bootstrap           # install tools/deps, build JS workspaces, build agent
pnpm bootstrap -- --native
                             # also build platform native NAPI modules
pnpm bootstrap -- --no-build
                             # install tools/deps only
```

Useful troubleshooting flags:

```bash
pnpm bootstrap -- --skip-tools     # never auto-install Bun/Rust
pnpm bootstrap -- --skip-rust      # install/check Bun, skip Rust install
pnpm bootstrap -- --skip-install   # do not run pnpm install
```

`pnpm doctor` also checks the transitive packages that Bun commonly reports as missing after an incomplete install, such as `lodash.debounce`, `proxy-from-env`, `combined-stream`, `hasown`, `json-schema-traverse`, and `shebang-regex`.

### Platform Notes

#### macOS

Install Apple's compiler tools once:

```bash
xcode-select --install
```

Then run:

```bash
pnpm bootstrap
```

For local native modules:

```bash
pnpm bootstrap -- --native
```

macOS may ask for Accessibility, Screen Recording, Microphone, or Automation permissions when computer-use, screenshot, audio, or URL handler features are used.

#### Windows

Run from PowerShell or Windows Terminal:

```powershell
pnpm bootstrap
```

The script uses the official Bun PowerShell installer and rustup installer when those tools are missing. Native Rust builds may also need Visual Studio 2022 Build Tools with the C++ workload. If native packaging fails, install the toolchain with:

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools --source winget --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive"
```

After installing Bun or Rust, a new terminal may be needed if the current shell does not pick up `~/.bun/bin` or `~/.cargo/bin`.

#### Linux

Install system build helpers first. On Debian/Ubuntu:

```bash
sudo apt update
sudo apt install -y curl unzip build-essential pkg-config libasound2-dev xclip wl-clipboard
```

Then run:

```bash
pnpm bootstrap
```

For local native audio:

```bash
pnpm bootstrap -- --native
```

## Configuration

Models are configured in `~/.axiomate.json`. On first run the file is created automatically — add your models to it:

```jsonc
{
  "searchProviders": {
    "exa": {
      "type": "exa",
      "apiKey": "exa_...",
      "searchType": "auto",
      "numResults": 10
    }
  },
  "models": {
    "qwen/qwen3-235b": {
      "model": "qwen/qwen3-235b",
      "name": "Qwen3 235B",
      "protocol": "openai",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "sk-...",
      "effort": "high",
      "contextWindow": 131072,
      "maxOutputTokens": 32768,
      "usageMapping": {
        "cacheReadTokens": [
          "usage.prompt_tokens_details.cached_tokens",
          "usage.prompt_cache_hit_tokens"
        ],
        "cacheMissTokens": "usage.prompt_cache_miss_tokens",
        "cacheWriteTokens": [
          "usage.prompt_tokens_details.cache_creation.cache_creation_input_tokens",
          "usage.prompt_tokens_details.cache_creation.ephemeral_5m_input_tokens"
        ]
      },
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
| `effort` | no | Fixed effort label shown in the model picker for configured models. Display only; does not automatically send Anthropic `output_config.effort` |
| `contextWindow` | no | Context window size in tokens |
| `maxOutputTokens` | no | Max output tokens per response |
| `supportsImages` | no | Whether the model supports image/vision input. Defaults to `true`. Set to `false` for text-only models to avoid API errors |
| `thinkingParams` | no | Vendor-specific thinking/reasoning params, merged into request when thinking is enabled |
| `extraParams` | no | Extra params merged into every API request body (passthrough) |
| `usageMapping` | no | OpenAI-compatible response paths for cache hit/miss/write token fields |

### Voice Dictation

`/voice` records microphone audio and sends it to the speech-to-text provider configured at `voice.stt` in `~/.axiomate.json`. The provider is independent from login/OAuth state and build-time feature flags.

OpenAI-compatible transcription endpoints:

```jsonc
{
  "voice": {
    "stt": {
      "type": "openai-compatible",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "model": "whisper-1",
      "responseFormat": "json"
    }
  }
}
```

Generic multipart HTTP endpoints:

```jsonc
{
  "voice": {
    "stt": {
      "type": "http",
      "url": "http://127.0.0.1:8080/transcribe",
      "apiKeyEnv": "LOCAL_STT_KEY",
      "authHeader": "Authorization",
      "authPrefix": "Bearer ",
      "fileField": "file",
      "model": "whisper-large-v3",
      "modelField": "model",
      "languageField": "language",
      "responsePath": "text"
    }
  }
}
```

The audio is sent as a 16 kHz mono WAV file. `extraParams` (`openai-compatible`) and `extraFields` (`http`) add provider-specific multipart fields without changing the voice integration.
`apiKey` and `apiKeyEnv` are optional for local or trusted `openai-compatible` and `http` services; they are required only for `"type": "openai"`.

### Search Providers

Search providers are configured once at the top level.

Current provider types:

- `"brave-web-search"` — Brave Search API web search endpoint
- `"exa"` — Exa Search API
- `"tavily"` — Tavily Search API
- `"serpapi"` — SerpApi Search API

If `searchProviders` contains multiple entries, `WebSearch` tries them in `searchProviders` order until one works.

Brave example:

```jsonc
{
  "searchProviders": {
    "brave": {
      "type": "brave-web-search",
      "apiKey": "BSA...",
      "baseUrl": "https://api.search.brave.com/res/v1/web/search",
      "country": "US",
      "searchLang": "en",
      "uiLang": "en-US",
      "count": 10,
      "safeSearch": "moderate",
      "extraSnippets": true
    }
  }
}
```

Exa example:

```jsonc
{
  "searchProviders": {
    "exa": {
      "type": "exa",
      "apiKey": "exa_...",
      "baseUrl": "https://api.exa.ai/search",
      "searchType": "auto",
      "category": "news",
      "userLocation": "US",
      "numResults": 10,
      "moderation": false,
      "highlightMaxCharacters": 1200
    }
  }
}
```

Tavily example:

```jsonc
{
  "searchProviders": {
    "tavily": {
      "type": "tavily",
      "apiKey": "tvly-...",
      "baseUrl": "https://api.tavily.com/search",
      "searchDepth": "basic",
      "maxResults": 8,
      "topic": "general",
      "includeAnswer": false,
      "country": "united states",
      "autoParameters": false,
      "exactMatch": false,
      "includeUsage": false
    }
  }
}
```

SerpApi example:

```jsonc
{
  "searchProviders": {
    "serpapi": {
      "type": "serpapi",
      "apiKey": "serp_...",
      "baseUrl": "https://serpapi.com/search.json",
      "engine": "google",
      "googleDomain": "google.com",
      "hl": "en",
      "gl": "us",
      "device": "desktop",
      "safe": "active",
      "num": 10
    }
  }
}
```

Multiple providers with automatic fallback:

```jsonc
{
  "searchProviders": {
    "exa": {
      "type": "exa",
      "apiKey": "exa_..."
    },
    "tavily": {
      "type": "tavily",
      "apiKey": "tvly-..."
    },
    "serpapi": {
      "type": "serpapi",
      "apiKey": "serp_..."
    }
  }
}
```

### Settings

Axiomate has a layered settings system. Settings files are read in order of precedence (highest wins):

| Scope | Path | Git-tracked |
|-------|------|-------------|
| Global | `~/.axiomate/settings.json` | no |
| Project | `<project>/.axiomate/settings.json` | yes |
| Local | `<project>/.axiomate/settings.local.json` | no (add to `.gitignore`) |

Settings control permissions, hooks, MCP servers, environment variables, and more. Example:

```jsonc
{
  "permissions": {
    "allow": ["Bash(pnpm build)", "Read", "Edit(src/**)"],
    "deny": ["Bash(rm -rf *)"]
  },
  "env": {
    "DEBUG": "true"
  }
}
```

### MCP Servers

[MCP (Model Context Protocol)](https://modelcontextprotocol.io/) lets you connect external tools, databases, and APIs. Configure in any settings file under `mcpServers`:

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..."
      }
    },
    "remote-server": {
      "type": "http",
      "url": "https://example.com/mcp"
    }
  }
}
```

Or use the CLI:

```bash
# Add stdio server
axiomate mcp add my-server -- npx -y @some/mcp-server

# Add HTTP server
axiomate mcp add --transport http my-server https://example.com/mcp

# Add with environment variables
axiomate mcp add -e API_KEY=xxx my-server -- npx my-mcp-server

# Add to specific scope (local, user, project)
axiomate mcp add -s user my-server -- npx my-mcp-server

# List configured servers
axiomate mcp list

# Remove a server
axiomate mcp remove my-server
```

Transport types: `stdio` (default, runs a local process), `http` (remote HTTP endpoint), `sse` (Server-Sent Events).

### Plugins

Axiomate supports the public plugin ecosystem. The official plugin marketplace at [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) is auto-installed on first run.

```bash
# Browse and install plugins
/plugin                         # interactive plugin browser

# CLI plugin management
axiomate plugin install <name>
axiomate plugin uninstall <name>
axiomate plugin list
```

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
    package-mac.ts                macOS executable packaging script
  clipboard-axiomate/             Clipboard access (Rust NAPI + PowerShell/xclip fallback)
  audio-capture-axiomate/         Audio recording (Rust NAPI, cpal)
  image-processor-axiomate/       Image processing (sharp wrapper)
  computer-use-native-axiomate/   Mouse/keyboard/screenshot (nut-js, node-screenshots)
  computer-use-dispatch-axiomate/ Computer use dispatch + 5-gate engine
  sandbox-axiomate/               Sandbox execution
  treeify-axiomate/               Directory tree display
  mcpb-axiomate/                  MCP bridge
```

## Roadmap — Rebuild Candidates

Axiomate was forked from Claude Code; during cleanup we removed a lot of Anthropic-service-coupled infrastructure. A handful of those removals were genuinely useful features tangled with private plumbing, not bad ideas. They're good candidates for a clean provider-neutral rebuild. See [DELETED_FEATURES.md](DELETED_FEATURES.md) for the full archive (including features already revived, features decided against rebuilding, and notes on each).

### Already revived

| Feature | Status |
|---------|--------|
| Onboarding / provider-setup wizard | ✓ Live (`be18fd0`). First-run picker for provider + `baseURL` + `apiKey`, verifies connection before persisting to `~/.axiomate.json` |
| Prompt suggestion + speculation | ✓ Live opt-in (`e8a7c39`). Ghost-text predictions + optional overlay-FS speculative execution |
| `/resume` deep + agentic search | ✓ Live opt-in (`3776449`). Fuzzy fulltext (Fuse.js, local) + LLM semantic search over session history |

### Top candidates (DEV-gated, ready to flip to opt-in)

The previous cleanup pass left a set of self-contained, axiomate-compatible features gated behind `feature('DEV')` — they surface only in dev builds. Each is ready to revive with the same pattern as the revivals above (settings field + `AXIOMATE_CODE_ENABLE_<FEATURE>` env var + `/config` toggle).

| Feature | Description | Rebuild cost |
|---------|-------------|--------------|
| VERIFICATION_AGENT | Independent adversarial verifier subagent for non-trivial implementation work. Catches "looks correct but actually broken" bugs | low |
| TREE_SITTER_BASH | AST-based bash parser (pure TS, 4436 LOC already in tree). Catches `trap/enable/hash` evil the regex path misses | low |
| EXTRACT_MEMORIES | Auto-extract durable learnings into project memory at session end | low |
| NATIVE_CLIPBOARD_IMAGE | macOS clipboard image fast path (~0.03ms warm vs ~1.5s osascript) | low |
| MESSAGE_ACTIONS | Edit/rerun past messages | low |
| HISTORY_PICKER | Interactive session history picker | low |
| TOKEN_BUDGET | Per-turn token budget UI display | low |
| COMMIT_ATTRIBUTION | Auto git `Co-Authored-By` metadata on commits | low |
| BUILTIN_EXPLORE_PLAN_AGENTS | Built-in Explore + Plan subagents | low |

See [DELETED_FEATURES.md](DELETED_FEATURES.md) Part E for the full Tier 1/2/3 breakdown and additional DEV-gated candidates.

### Non-trivial rebuilds

| Feature | Description | Rebuild cost |
|---------|-------------|--------------|
| Reactive compaction (A1) | Mid-stream `prompt_too_long` / media-size auto-recovery. Saves hard failures → retries compacted. Reuses existing `compactConversation` | moderate |
| Bash classifier | LLM-based "is this command read-only safe?" for permission auto-approval. Original lived in Anthropic's monorepo; clean rebuild against `getFastModel` | moderate |
| `/export` to local markdown/HTML | Replaces deleted `transcript-share` (which uploaded to Anthropic service). Local export for sharing | low |
| `/privacy-settings` screen | UI wrapper for telemetry / memory opt-out env vars | low |

**Rebuild contract for all of the above:** must stay provider-neutral — no Anthropic-specific betas, no private endpoints, no OAuth. Reuse `classifyError()`, `getProviderForModel()`, `getFastModel()` / `getMidModel()`, and `provider.inference()` rather than assuming Anthropic wire shapes. See [DELETED_FEATURES.md](DELETED_FEATURES.md) Part C for patterns.

## Build

### Development

Build support workspaces first, then bundle the agent into a single JS file. The development build requires `node_modules` at runtime.

```bash
pnpm build        # agent/dist/cli.js
pnpm start        # run with Bun
```

`pnpm build` includes both support workspace builds and the agent bundle. If you only changed agent source and the support workspaces are already built, use:

```bash
pnpm build:agent
```

Manual dependency install:

```bash
pnpm install
```

Use pnpm from the repo root so the workspace layout matches `pnpm-lock.yaml`.

### Tests

```bash
pnpm test
```

### Windows Standalone Exe

Compiles everything into a standalone `axiomate.exe` + native addon files. No Bun or node_modules needed to run.

**Additional prerequisite:** Rust with `x86_64-pc-windows-msvc` target.

```bash
pnpm package:win
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

### macOS Standalone Executable

Compiles everything into a standalone `axiomate` executable + native addon files. No Bun or node_modules needed to run.

```bash
pnpm package:mac
```

Output in `agent/dist/`:

```
axiomate                                  Bun runtime + all JS
sharp-darwin-*.node                      image processing
libvips-cpp.42.dylib                     sharp runtime library
libnut.node                              mouse/keyboard control
permissions.node                         macOS permission checks
node-screenshots.darwin-*.node           screenshots
*-axiomate.node                          workspace native addons
*-axiomate.darwin-*.node                 workspace native addon aliases
```

All files must stay in the same directory. To distribute, copy the entire `dist/` folder.

## License

N/A
