# Changelog

## 0.1.0

### Features
- Multi-provider architecture: protocol-neutral LLM abstraction layer
- Anthropic Provider with full streaming, retry, non-streaming fallback support
- Provider registry with glob-pattern model routing (`registerProvider`)
- Typed `bind()` pattern for provider-specific request configuration
- Neutral type system: `StreamIntent`, `StreamEvent`, `ContentBlock`, `LLMMessage`
- `LLMAPIError` / `LLMAbortError` / `LLMTimeoutError` error class hierarchy
- Safe header access (`getHeader`) for SDK Proxy compatibility
- `NeutralToolSchema` with provider-hint fields (strict, defer_loading, cache_control)
- Protocol-neutral `RequestHooks` and `ProviderEvent` system

### Architecture
- Zero SDK imports in the LLM orchestration layer
- 237 unit tests covering provider abstraction, error handling, streaming pipeline
- Compatible with Anthropic firstParty, Bedrock, Vertex, Foundry backends
