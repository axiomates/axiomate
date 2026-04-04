# Axiomate

An AI agent framework with multi-provider support, built from the ground up using battle-tested components extracted from claude-code.

## Features

- **Multi-provider AI** — OpenAI, Anthropic, and self-hosted API support
- **Terminal UI** — Rich terminal interface with double-buffered rendering, mouse events, scrolling, text selection
- **Tool system** — Extensible tool framework (Bash, file operations, search, etc.)
- **Cross-platform** — Windows, macOS, Linux

## Quick Start

```bash
# Clone and install
git clone <repo-url> axiomate
cd axiomate
npm install

# Build the agent
npm run build --workspace=agent

# Run
node agent/dist/main.js
```

## Packages

| Package | Description |
|---------|-------------|
| `agent` | AI agent core (in development) |
| `ink-axiomate` | Terminal UI rendering engine |
| `yoga-axiomate` | Pure TypeScript flexbox layout engine |
| `utils-axiomate` | Terminal utilities (string width, ANSI, env detection, etc.) |
| `file-index-axiomate` | Fuzzy file search engine |
| `color-diff-axiomate` | Syntax-highlighted diff rendering |
| `treeify-axiomate` | Terminal tree renderer |
| `clipboard-axiomate` | Cross-platform clipboard access |
| `image-processor-axiomate` | Image processing (resize, compress, format conversion) |
| `modifiers-mac-napi-axiomate` | macOS keyboard modifier key detection |
| `url-handler-mac-napi-axiomate` | macOS URL scheme handler |
| `audio-capture-axiomate` | Cross-platform audio recording/playback |

## Development

```bash
# Install all dependencies
npm install

# Build a specific package
npm run build --workspace=ink-axiomate

# Run tests
npm test --workspace=image-processor-axiomate

# Build Rust NAPI packages (requires Rust toolchain)
cd clipboard-axiomate && npm run build
```

## Architecture

```
                    yoga-axiomate
                         │
utils-axiomate ──────────┤
    │                    │
    ├── ink-axiomate ────┤
    ├── color-diff-axiomate
    │                    │
    └────────────────── agent ──── AI providers (OpenAI / Anthropic / custom)
                         │
file-index-axiomate ─────┤
treeify-axiomate ────────┤
clipboard-axiomate ──────┤
  └── image-processor-axiomate
audio-capture-axiomate ──┤
modifiers-mac-napi ──────┤
url-handler-mac-napi ────┘
```

## Requirements

- Node.js 22+
- Rust 1.94+ (for native NAPI packages, optional)
- macOS: Xcode Command Line Tools (for Rust NAPI build)
- Linux: `libasound2-dev` (for audio-capture build)

## License

MIT
