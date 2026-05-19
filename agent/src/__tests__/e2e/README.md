# End-to-End Tests

Placeholder. Not implemented.

When to put a test here: when it needs the **full CLI process**,
including Ink rendering, keybindings, REPL state, stdin/stdout piping.
Typical shape:

```ts
const proc = spawn('bun', ['dist/cli.js', '-p', '...'])
// pipe inputs, assert on stdout
```

## Running

```bash
pnpm run test:e2e   # currently runs zero tests
```

Until we have a real need (e.g., verifying `/config` dialog behaves
correctly end-to-end, or testing the REPL's stdin/stdout wiring), this
folder stays empty.

## Why separate from integration?

- E2E is **slow** (seconds to minutes per test — full CLI boot)
- E2E is **fragile** (terminal quirks, color codes, async timing)
- E2E tests **run last** or on release — not per-PR

Integration tests at `../integration/` cover most of what we need
without paying the E2E cost.
