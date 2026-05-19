# Axiomate

Multi-provider AI agent CLI with full desktop automation. Chat, code, and control your computer — all from the terminal. Bring your own model from any provider (OpenRouter, SiliconFlow, ollama, vLLM, Anthropic, etc.). No vendor lock-in.

## Features

- **Bring your own model** — Three wire protocols supported: OpenAI Chat Completions (OpenRouter, SiliconFlow, DeepSeek, vLLM, ollama, ...), OpenAI Responses API (OpenAI o-series, GPT-5, third-party Responses-compatible gateways — preserves reasoning items across tool calls), and Anthropic Messages. Mix freely across `currentModel` / `fastModel` / `midModel`.
- **Computer Use** — 25+ desktop automation tools: screenshot with coordinate rulers, zoom with Set-of-Mark overlays, mouse/keyboard control, natural-language UI element targeting (`vision_locate` + `accept`), batch actions, and teachable macros. Windows UIAutomation integration for pixel-accurate element detection.
- **Coding Tools** — Read, Write, Edit, Bash, Grep (ripgrep), Glob, Notebook. Full codebase exploration and modification.
- **Skills** — 11 built-in skills (`/verify`, `/simplify`, `/remember`, `/batch`, `/stuck`, `/loop`, etc.) plus user-defined skills via `SKILL.md` files.
- **Plugins** — Full marketplace system with browse/install/manage UI, autoupdate, blocklist, and dependency resolution.
- **MCP** — Connect any MCP server (stdio, HTTP, SSE) for extensible tooling.
- **Multi-model** — Three-tier model architecture (`currentModel` / `fastModel` / `midModel`) for cost-optimized task routing.
- **Web Search** — Multi-provider search (Brave, Exa, Tavily, SerpApi) with automatic fallback.
- **Voice Dictation** — `/voice` sends microphone audio to OpenAI-compatible or HTTP STT endpoints.
- **Cross-platform** — Windows, macOS, Linux. Ships as a single Bun-compiled executable with bundled native addons.

## Prerequisites

- [Node.js](https://nodejs.org/) 20+ (npm bundled — the bootstrap script uses it once to install pnpm if missing; it's not a runtime dep)
- [pnpm](https://pnpm.io/) — primary package manager. Skip if you'll let bootstrap install it for you. Manual install:
  ```bash
  npm install -g pnpm
  ```
- Git
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) — **bundled automatically** in every distribution mode (pnpm/npm install via `@vscode/ripgrep`; packaged `axiomate.exe`/`axiomate` ship `rg` next to the binary). You don't need to install ripgrep yourself in normal use; a system `rg` on `PATH` is treated as a fallback only.
- **Windows only**: Visual Studio 2022 Build Tools with the C++ workload — needed by Rust NAPI compilation. The bootstrap script **auto-installs it via `winget`** when missing, so most users don't need to do anything in advance. If you want it pre-installed (or your environment doesn't have winget), see the [Windows section](#windows) below.

The bootstrap script will auto-install Bun, Rust, pnpm itself, and the Windows VS Build Tools (Windows only) when any of them are missing. So once you have Node + Git, `npm run bootstrap` (or `node scripts/bootstrap.mjs`) is enough for a clean machine. If pnpm is already installed, prefer `pnpm run bootstrap` — same behavior.

### How ripgrep is resolved

At startup Axiomate picks `rg` in this order:

1. **Bundled** —
   - Packaged exe: `dirname(process.execPath) + 'rg(.exe)'` (the rg binary copied next to `axiomate.exe`/`axiomate` by `package:win`/`package:mac`).
   - npm/pnpm distribution: the `rgPath` exported by `@vscode/ripgrep`, which resolves to the platform-specific subpackage (`@vscode/ripgrep-{platform}-{arch}/bin/rg{.exe}`) installed automatically.
2. **System `rg`** on `PATH` (fallback only — useful for environments where the bundled binary is unavailable).
3. If neither is found Axiomate fails fast with an install hint.

This means a normal `pnpm run bootstrap` clone or a downloaded release artifact gets the same fixed ripgrep version (15.0.0 at the time of writing, via `@vscode/ripgrep`). PATH version drift stops mattering.

### Manually installing ripgrep (only if the bundled binary is missing)

You shouldn't need this in normal use. Reach for it only if:
- you hand-relocated `axiomate.exe` without its sibling files (and want to keep the relocation), or
- you're on a platform/arch the `@vscode/ripgrep` subpackages don't cover, or
- a corporate policy strips bundled binaries on download.

#### Online install

Install ripgrep with your normal package manager:

```bash
# macOS
brew install ripgrep

# Windows (pick one)
winget install BurntSushi.ripgrep.MSVC
scoop install ripgrep
choco install ripgrep

# Linux
sudo apt install ripgrep        # Debian / Ubuntu
sudo dnf install ripgrep        # Fedora / RHEL
sudo pacman -S ripgrep          # Arch
```

Verify with:

```bash
rg --version
```

#### Offline install

If the target machine has no internet access, install ripgrep by copying a prebuilt binary from another machine.

1. On a connected machine, download the correct ripgrep release archive for the target platform and CPU from the official ripgrep GitHub releases page.
2. Transfer the archive to the offline machine using your normal internal method (USB drive, internal artifact mirror, shared folder, SCCM/Intune/Jamf, etc.).
3. Extract it into a stable tools directory.
4. Add that directory to `PATH`.
5. Verify with `rg --version`.

Typical offline layouts:

- Windows:
  - copy `rg.exe` to a directory such as `C:\Tools\ripgrep\`
  - add `C:\Tools\ripgrep\` to the system or user `PATH`
  - or distribute it through WinGet private repos / Intune / SCCM if your environment already uses them
- macOS:
  - extract the release tarball somewhere stable, for example `/usr/local/ripgrep/` or `/opt/ripgrep/`
  - symlink or add that directory to `PATH`
- Linux:
  - extract the release tarball to `/opt/ripgrep/` or another managed tools directory
  - symlink `rg` into `/usr/local/bin/`, or add the directory to `PATH`

Example PATH updates:

```powershell
# Windows PowerShell
$env:Path = "C:\Tools\ripgrep;$env:Path"
```

```bash
# macOS / Linux
export PATH="/opt/ripgrep:$PATH"
```

If you maintain an internal software mirror, the cleanest setup is to mirror the official ripgrep release artifacts and install from that mirror instead of relying on public package repositories. Axiomate will pick up that `rg` automatically as the system fallback.

The repo uses pnpm workspaces. Bun is used by the build/runtime scripts, not as the primary installer.

(We migrated off npm because of a long-standing `optionalDependencies` × workspaces bug that silently drops platform-specific native bindings — see https://github.com/npm/cli/issues/4828. npm is still bundled with Node and used by the bootstrap script as the install path for pnpm; pnpm itself does not depend on npm at runtime.)

## Quick Start

```bash
git clone https://github.com/axiomates/axiomate.git
cd axiomate

# Bootstrap auto-installs pnpm + Bun + Rust (+ VS Build Tools on Windows)
# when any are missing, then installs deps and builds everything.
npm run bootstrap

# After the first run, prefer pnpm:
pnpm run start
```

### Automated Environment Setup

The bootstrap script works on macOS, Windows, and Linux. It probes Node/pnpm/Bun/Rust/Git (and on Windows: Visual Studio 2022 Build Tools), auto-installs whatever is missing, runs `pnpm install`, builds workspace packages including platform native NAPI modules, and builds the agent.

```bash
pnpm run doctor              # probe only, do not install or build
pnpm run bootstrap           # install tools/deps, build all workspaces (JS + native), build agent
pnpm run bootstrap --no-native
                             # skip native NAPI builds (no Rust required)
pnpm run bootstrap --no-build
                             # install tools/deps only
```

Useful troubleshooting flags:

```bash
pnpm run bootstrap --skip-tools     # never auto-install Bun / Rust / VS Build Tools / pnpm
pnpm run bootstrap --skip-bun       # check/install everything except Bun
pnpm run bootstrap --skip-rust      # check/install everything except Rust
pnpm run bootstrap --skip-install   # do not run pnpm install
```

`pnpm run doctor` also checks the transitive packages that Bun commonly reports as missing after an incomplete install, such as `lodash.debounce`, `proxy-from-env`, `combined-stream`, `hasown`, `json-schema-traverse`, and `shebang-regex`.

### Platform Notes

#### macOS

Install Apple's compiler tools once:

```bash
xcode-select --install
```

Then run:

```bash
pnpm run bootstrap
```

This builds the macOS native NAPI modules (clipboard, modifiers, url-handler, computer-use) by default. Pass `--no-native` to skip them.

macOS may ask for Accessibility, Screen Recording, Microphone, or Automation permissions when computer-use, screenshot, audio, or URL handler features are used.

#### Windows

Run from PowerShell or Windows Terminal:

```powershell
pnpm run bootstrap
```

The script uses the official Bun PowerShell installer + rustup installer when those tools are missing, and a three-tier probe (`vswhere.exe` → `cl.exe` on PATH → `HKLM\SOFTWARE\Microsoft\VisualStudio\Setup` registry) for VS Build Tools. When the probe finds nothing, it auto-installs via:

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools --source winget --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive"
```

If you'd rather pre-install (or your environment doesn't have winget), run the same command yourself before bootstrap. Once it finishes, the bootstrap probe will detect it and skip the install step.

After installing Bun, Rust, or VS Build Tools, a new terminal may be needed if the current shell does not pick up `~/.bun/bin`, `~/.cargo/bin`, or the freshly registered VS Installer paths.

#### Linux

Install system build helpers first. On Debian/Ubuntu:

```bash
sudo apt update
sudo apt install -y curl unzip build-essential pkg-config libasound2-dev xclip wl-clipboard
```

Then run:

```bash
pnpm run bootstrap
```

This builds the audio-capture NAPI module by default. Pass `--no-native` to skip it.

##### WSL note

If you're running WSL on Windows and the host has Node + Bun installed, WSL's PATH-passthrough exposes `bun.exe` as `/mnt/c/.../bun`. Bootstrap detects this and installs a native Linux Bun, but you need to make sure your shell picks it up afterwards. The Bun installer appends `BUN_INSTALL` + `PATH` lines to `~/.bashrc`; for login shells (which is what pnpm scripts spawn), copy the same two lines into `~/.profile`:

```bash
echo '' >> ~/.profile
echo 'export BUN_INSTALL="$HOME/.bun"' >> ~/.profile
echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> ~/.profile
```

Then start a new WSL session. Verify with `which bun` — it should print `/root/.bun/bin/bun` (or wherever your HOME is), not `/mnt/c/...`.

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
      "protocol": "openai-chat",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "sk-...",
      "contextWindow": 131072,
      "maxOutputTokens": 32768,
      "thinking": { "enabled": true, "budget": 8192 },
      "usageMapping": {
        "cacheReadTokens": [
          "usage.prompt_tokens_details.cached_tokens",
          "usage.prompt_cache_hit_tokens"
        ]
      }
    },
    "o4-mini": {
      "model": "o4-mini",
      "name": "o4-mini (Responses)",
      "protocol": "openai-responses",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "contextWindow": 200000,
      "maxOutputTokens": 100000,
      "thinking": { "enabled": true, "effort": "high" }
    },
    "deepseek-v4-pro": {
      "model": "deepseek-v4-pro",
      "protocol": "openai-chat",
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "sk-...",
      "thinking": { "enabled": true, "effort": "high" }
    }
  },
  "currentModel": "qwen/qwen3-235b",
  "fastModel": "qwen/qwen3-235b",
  "midModel": "qwen/qwen3-235b"
}
```

Each model declares `thinking` in axiomate's neutral form. axiomate translates it to the right wire field for that provider via a vendor template — `enable_thinking`+`thinking_budget` for Qwen, `reasoning.effort`+`summary` for OpenAI Responses, `reasoning_effort` for DeepSeek (with low/medium auto-collapsed to high per their docs), `thinking.budget_tokens`+`output_config.effort` for Anthropic. You don't have to remember each provider's shape — just declare `effort` and/or `budget`.

The `o4-mini` entry uses the OpenAI Responses API (`/v1/responses`), which preserves reasoning items across tool-call rounds. The `qwen/qwen3-235b` and `deepseek-v4-pro` entries use Chat Completions (`/v1/chat/completions`). See the [Protocol](#protocol) section below for picking between them.

### Model Config Fields

| Field | Required | Description |
|-------|----------|-------------|
| `model` | yes | Model ID sent to the provider API |
| `name` | no | Display name in the model picker |
| `protocol` | yes | `"openai-chat"`, `"openai-responses"`, or `"anthropic"` — determines wire format. See [Protocol](#protocol) below |
| `vendor` | no | Vendor template name. Built-in: `openai-default`, `openai-responses`, `anthropic`, `deepseek-reasoning`, `openai-ali-thinking`. When omitted, axiomate infers from `protocol` + `baseUrl` (then model name as a last resort). Override when the inference picks the wrong template (e.g., a self-hosted relay that mirrors the SiliconFlow wire schema needs an explicit `vendor: "openai-ali-thinking"`) |
| `baseUrl` | yes | API endpoint URL |
| `apiKey` | yes | API key for authentication |
| `contextWindow` | no | Context window size in tokens |
| `maxOutputTokens` | no | Max output tokens per response |
| `supportsImages` | no | Whether the model supports image/vision input. Defaults to `true`. Set to `false` for text-only models to avoid API errors |
| `thinking` | no | Reasoning declaration: `{ enabled: bool, effort?: "low"\|"medium"\|"high"\|"max", budget?: number }`. Presence acts as the opt-in switch. axiomate translates to the vendor's wire format automatically. Omit the field on models that don't support thinking |
| `extraParams` | no | Extra params merged verbatim into every API request body. Escape hatch for vendor-specific knobs not covered by `thinking` |
| `usageMapping` | no | OpenAI Chat Completions response paths for cache hit/miss/write token fields. Not needed for `openai-responses` or `anthropic` |
| `userAgent` | no | Override the HTTP `User-Agent` header. Some third-party Responses-compatible gateways gate access by client identifier; set this to a permitted UA (e.g., `codex_cli_rs/0.50.0`) to pass through |
| `repairToolCalls` | no | Opt-in compatibility shim for models that emit malformed tool-call JSON |
| `stallTimeoutMs` | no | Override the streaming stall warning threshold in ms. Set to `0` to disable stall warnings entirely |

Top-level `templates: { ... }` lets you define custom vendor templates that extend a built-in. Useful when a provider invents a new wire shape; see `agent/src/services/api/vendorTemplates.ts` for the DSL.

### Editing models and templates

Once a model is configured you can revise any field without leaving axiomate or hand-editing `~/.axiomate.json`:

- `/model edit <id>` — opens your `$EDITOR` (`AXIOMATE_EDITOR`, `VISUAL`, then `EDITOR`; defaults to `vi` / `notepad`) with the model entry as JSON. Save and close to apply, or close without saving to skip. Invalid JSON or schema violations show a list of paths and let you re-edit with your typed content preserved.
- `/template list` — shows built-in and custom templates side-by-side, with each custom template's `extends` annotated.
- `/template show <name>` — pretty-prints the resolved template (with `extends` flattened).
- `/template new` — interactive flow: pick a unique name → pick a base to inherit from → editor opens with the base prefilled. Save to register the template under top-level `templates` in `~/.axiomate.json`. The new template is then selectable as `vendor:` in any model entry (and immediately in the `/model add` wizard's vendor step).
- `/template delete <name>` — removes a custom template after a confirmation prompt. Built-in templates are protected and cannot be deleted.

For complex GUI editors (VS Code, Sublime), make sure your `EDITOR` includes a wait flag — e.g. `EDITOR='code --wait'` or `EDITOR='subl --wait'` — so axiomate blocks until you close the file.

#### Custom vendor template example

A vendor template is a JSON object describing how to translate the neutral `thinking` declaration into wire fields. The DSL has four main parts: `enabledPatch` / `disabledPatch` (merged whenever thinking is on/off), `effort.patch` (containing the placeholder `<value>` to substitute the user's effort level), and `effort.valueMap` (optional remapping of axiomate's neutral effort levels to vendor-specific strings).

**Example 1 — wrap a private API with non-standard effort tiers:**

```jsonc
{
  "templates": {
    "my-private-thinking": {
      "extends": "openai-default",
      "enabledPatch": { "thinking_mode": "on" },
      "effort": {
        "patch": { "intelligence_level": "<value>" },
        "valueMap": {
          "low": "1",
          "medium": "2",
          "high": "3",
          "max": "9999"
        }
      }
    }
  }
}
```

When a model with `vendor: "my-private-thinking"` and `thinking: { enabled: true, effort: "low" }` sends a request, the wire body has `thinking_mode: "on"` + `intelligence_level: "1"` at the top level.

**Example 2 — override a built-in's value remapping:**

The built-in `deepseek-reasoning` template collapses `low/medium → high` to match what DeepSeek's docs say their server accepts. If you want to send the literal axiomate level (e.g., to test what the server actually does with `low`), define a derived template with an identity `valueMap`:

```jsonc
{
  "templates": {
    "deepseek-honest": {
      "extends": "deepseek-reasoning",
      "effort": {
        "patch": { "reasoning_effort": "<value>" },
        "valueMap": {
          "low": "low",
          "medium": "medium",
          "high": "high",
          "max": "max"
        }
      }
    }
  },
  "models": {
    "deepseek-v4-pro-strict": {
      "model": "deepseek-v4-pro",
      "protocol": "openai-chat",
      "vendor": "deepseek-honest",
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "sk-...",
      "thinking": { "enabled": true, "effort": "low" }
    }
  }
}
```

Now the ModelPicker's "Low" choice sends `reasoning_effort: "low"` literally rather than collapsing to "high".

The full DSL (with `budget`, `anthropicThinkingField`, `autoRoundTripReasoningContent`) is documented inline in `agent/src/services/api/vendorTemplates.ts`. Use `/template new` for an interactive wizard that prefills a built-in's JSON for you to modify.

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
    "allow": ["Bash(pnpm run build)", "Read", "Edit(src/**)"],
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

### Skills

Axiomate ships with built-in skills and supports user-defined skills via `SKILL.md` files.

**Built-in skills:**

| Skill | Command | Description |
|-------|---------|-------------|
| Verify | `/verify` | Verify a code change does what it should by running the app |
| Simplify | `/simplify` | Review changed code for reuse, quality, and efficiency, then fix issues |
| Remember | `/remember` | Review auto-memory entries and propose promotions to project/team memory |
| Batch | `/batch` | Decompose large changes into 5-30 parallel worktree agents that each open a PR |
| Stuck | `/stuck` | Diagnose frozen/stuck/slow sessions on this machine |
| Loop | `/loop` | Schedule a recurring prompt/cron task (e.g., `/loop 5m check the deploy`) |
| Debug | `/debug` | Enable debug logging and help diagnose issues |
| Update Config | `/update-config` | Configure settings.json: permissions, hooks, env vars, MCP servers, plugins |
| Lorem Ipsum | `/lorem-ipsum` | Generate filler text for long context testing (specify token count) |
| Keybindings | `/keybindings-help` | Customize keyboard shortcuts / `~/.axiomate/keybindings.json` |

**User-defined skills** are Markdown files in `.axiomate/skills/<name>/SKILL.md`. They support conditional activation via `paths` frontmatter, dynamic discovery from edited file paths, and MCP-sourced skill loading.

### Protocol

The `protocol` field determines the wire format axiomate uses to talk to the model endpoint. Three values are supported:

| Value | Endpoint | Best for |
|---|---|---|
| `"openai-chat"` | `POST {baseUrl}/chat/completions` | The de-facto standard. Use for any third-party OpenAI-compatible gateway: OpenRouter, SiliconFlow, DeepSeek, Together, Groq, Mistral, vLLM, ollama, LM Studio, LocalAI, ... |
| `"openai-responses"` | `POST {baseUrl}/responses` | OpenAI's newer Responses API. Use for OpenAI o-series / GPT-5 (official), and any gateway that explicitly supports `/v1/responses`. **Preserves reasoning items across tool-call rounds** — strongly preferred for reasoning models in agentic loops |
| `"anthropic"` | `POST {baseUrl}/v1/messages` | Anthropic's Messages API. Use for Anthropic direct or any provider that implements the Anthropic wire format |

**Picking between `openai-chat` and `openai-responses`:**

- If your provider documents Responses API support and the model is a reasoning model (o-series, GPT-5, etc.), pick `openai-responses`. Multi-step tool loops keep their chain of thought via reasoning items — without this, the model re-reasons from scratch on every turn.
- If your provider only documents Chat Completions, or you're using a non-reasoning model, pick `openai-chat`. It's universally supported and zero-friction.
- DeepSeek V4 / Qwen3 thinking / etc. all use Chat Completions with vendor-specific reasoning fields. axiomate's vendor template system handles the differences for you — see "Vendor templates" below.

**Vendor templates:**

axiomate has five built-in vendor templates that translate the neutral `thinking: { enabled, effort?, budget? }` declaration into wire-specific fields:

| Vendor | When | Wire fields it produces |
|---|---|---|
| `openai-default` | Generic OpenAI Chat Completions endpoint | `reasoning_effort` |
| `openai-responses` | Auto-picked by `protocol: "openai-responses"` | `reasoning: { effort, summary: "auto" }` |
| `anthropic` | Auto-picked by `protocol: "anthropic"` | `thinking: { type: "enabled", budget_tokens }` + `output_config: { effort }` |
| `deepseek-reasoning` | Auto-picked when model name matches DeepSeek V4+ | `reasoning_effort` (with low/medium auto-collapsed to high per DeepSeek docs) + automatic `reasoning_content` round-trip |
| `openai-ali-thinking` | Auto-picked when `baseUrl` is `api.siliconflow.cn` or `dashscope.aliyuncs.com` | `enable_thinking` + `reasoning_effort` (low/medium collapse to high) + `thinking_budget` |

axiomate auto-picks a vendor based on `protocol` + `baseUrl` first, then model name as a last resort. The gateway-first ordering matters because `api.siliconflow.cn` and `dashscope.aliyuncs.com` use a single wire schema for every thinking-capable model they host (Qwen, GLM, Kimi, MiniMax, even DeepSeek). Override with `vendor: "..."` if you're relaying through a non-canonical host.

**Enabling thinking / reasoning:**

Thinking is purely opt-in via the `thinking` field. If you don't write it, axiomate sends no reasoning params (so reasoning-unaware gateways stay happy):

```jsonc
// OpenAI o-series / GPT-5 via Responses
"thinking": { "enabled": true, "effort": "high" }

// Anthropic extended thinking
"thinking": { "enabled": true, "effort": "high", "budget": 16000 }

// DeepSeek V4 (any OpenAI-compatible gateway)
"thinking": { "enabled": true, "effort": "high" }

// Qwen3 with token budget
"thinking": { "enabled": true, "budget": 8192 }

// Qwen3 with thinking explicitly off
"thinking": { "enabled": false }
```

`effort` and `budget` are independent — vendors that only accept one of them will ignore the other. Provide whichever level of control matches what the vendor's API documents.

**Custom vendor templates:**

When a provider invents a new wire shape, you can register a template under top-level `templates` in `~/.axiomate.json` and reference it via `vendor: "<your-name>"` in a model entry. See the DSL definition in `agent/src/services/api/vendorTemplates.ts`.

### Multi-Model Setup

- `currentModel` — main model for the conversation loop
- `fastModel` — cheap/fast model for lightweight tasks (token estimation, session search). Falls back to `currentModel`
- `midModel` — mid-tier model for reasoning tasks (memory selection, classification). Falls back to `currentModel`

All three are keys into the `models` map. If only `currentModel` is set, it's used for everything.

## Project Structure

| Package | Description |
|---------|-------------|
| `agent/` | Main CLI application. Entry point, API providers, model selection, configuration, skills, plugins |
| `computer-use-mcp-axiomate/` | Computer-use MCP server: 25+ tools + 5-gate dispatch engine (tools, permissions, coordinates, safety) |
| `computer-use-mac-napi-axiomate/` | macOS native bindings: SCContentFilter screenshots, CGEventTap Esc hotkey, CGWindowList capture, NSRunningApplication hide/unhide/activate, app_under_point |
| `computer-use-win-napi-axiomate/` | Windows native bindings: UIAutomation element detection, WindowFromPoint hit-test, MonitorFromWindow display mapping, SetForegroundWindow, BitBlt/PrintWindow screenshots, SendInput mouse/keyboard, WH_KEYBOARD_LL ESC hotkey |
| `clipboard-axiomate/` | Cross-platform clipboard access: Rust NAPI on macOS, PowerShell fallback on Windows, xclip/wl-paste on Linux |
| `modifiers-mac-napi-axiomate/` | macOS native keyboard modifier key state polling via Rust NAPI |
| `url-handler-mac-napi-axiomate/` | macOS native URL scheme handler via Rust NAPI (Apple Event kAEGetURL) |
| `audio-capture-axiomate/` | Cross-platform native audio recording and playback via Rust NAPI (cpal) |
| `image-processor-axiomate/` | Cross-platform image processing (sharp wrapper) + clipboard image access |
| `sandbox-axiomate/` | Local process sandbox for AI agent command execution (bwrap/sandbox-exec) |
| `treeify-axiomate/` | Render nested objects as terminal tree strings with optional coloring |
| `mcpb-axiomate/` | DXT/MCPB plugin format parser (manifest validation, pack/unpack, signing) |
| `scripts/` | Build tooling: `bootstrap.mjs` (auto-installs toolchain + builds all workspaces) and `load-napi.js` (NAPI .node binary loader) |

## Development Roadmap

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
pnpm run build        # agent/dist/cli.js
pnpm run start        # run with Bun
```

`pnpm run build` includes both support workspace builds and the agent bundle. If you only changed agent source and the support workspaces are already built, use:

```bash
pnpm run build:agent
```

Manual dependency install:

```bash
pnpm install
```

Use pnpm from the repo root so the workspace layout matches `pnpm-lock.yaml`.

### Tests

Unit tests run by default (~1100 tests, ~10s):

```bash
pnpm run test
```

Integration tests hit a real LLM and use a separate gitignored credentials file at `agent/src/__tests__/integration/config/local.json` — they do **not** touch your real `~/.axiomate.json`. First-time setup is documented in [`agent/src/__tests__/integration/README.md`](agent/src/__tests__/integration/README.md).

```bash
pnpm run test:integration    # 6 files, real LLM (Qwen3 8B by default)
pnpm run test:e2e            # placeholder; no e2e tests yet
pnpm run test:all            # unit + integration + e2e
pnpm run test:coverage       # unit + V8 coverage
pnpm run test:coverage:all   # all + V8 coverage
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