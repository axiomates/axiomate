# Integration Tests

Tests that exercise axiomate's core functions (`compactConversation`,
`runToolUse`, etc.) with **real** collaborators:

- **Real LLM** via the user's configured models (Qwen3 8B default, see
  [`config/testModels.ts`](./config/testModels.ts))
- **Real runtime pipeline** (provider → stream accumulator → repair →
  dispatch) wired through axiomate's actual code paths

These are **not** unit tests (no synthetic I/O isolation) and **not**
end-to-end tests (no CLI spawn, no REPL). They sit in the middle of the
test pyramid and catch classes of bugs unit tests can't:

- Prompt behavior changes in the wild (LLM stopped obeying our instructions)
- Runtime wiring regressions (refactor disconnected a component)
- Multi-step pipeline bugs (tool_use → repair → dispatch paths)

## Running

```bash
# Default `bun test` excludes integration — these do NOT run automatically.
bun run test:integration         # run all integration tests
bun run test:all                 # unit + integration in one go
bun run test:coverage:all        # coverage including integration
```

## Required setup

Integration tests that call a real LLM need the corresponding model
configured in `~/.axiomate.json`. If a test requires
`TEST_MODELS.summarization = 'Qwen/Qwen3-8B'` but that model isn't in
your config, the test throws with a clear setup message.

## Adding a new integration test

1. Decide if you need a real LLM or a mocked provider:
   - Real LLM: use `helpers/realLLMContext.ts` — tests prompt behavior
   - Mocked: use `helpers/mockedProvider.ts` — tests pipeline wiring given
     a specific response shape
2. If you need a new test-model category (e.g., vision), add it to
   `config/testModels.ts` and document why
3. Keep assertions **tolerant** — LLM output varies. Assert on structural
   properties (`expect(s).toContain('bug3')`, section headers present),
   not exact strings
4. Set a generous test timeout (e.g., 60s) for real-LLM tests; they're
   slow and may rate-limit

## When to run

- After landing any PR that modifies compact or jsonRepair / toolCall repair
- Before cutting a release
- Manually by developer triggering `bun test:integration` — no CI
  auto-run (yet)

## Not in this folder

- Pure-synthetic unit tests → stay in `agent/src/**/__tests__/*.test.ts`
  colocated with source
- Full CLI spawn / REPL tests → `../e2e/` (placeholder, not implemented)
