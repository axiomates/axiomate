# Tests

Three-tier convention. New tests go in the tier that matches their dependencies, not the feature they cover.

```
agent/src/__tests__/
├── unit/          ← default — mock-based, deterministic, ms-fast
├── integration/   ← real LLM via user's configured fast model
├── e2e/           ← full CLI process spawn (currently empty)
├── normalizeContentFromAPI.test.ts  (legacy — pending move to unit/)
├── privateProtocolResidue.test.ts   (legacy — pending move to unit/)
├── smoke.test.ts                    (legacy — pending move to unit/)
└── visionLocateConfig.test.ts       (legacy — pending move to unit/)
```

## Running

| Command                | Runs                                            |
| ---------------------- | ----------------------------------------------- |
| `pnpm test`            | `unit/` — fast, runs on every save              |
| `pnpm test:unit`       | Same as `pnpm test`                             |
| `pnpm test:integration`| `integration/` — requires API keys, costs money |
| `pnpm test:e2e`        | `e2e/` — currently zero tests                   |
| `pnpm test:all`        | All three tiers                                 |
| `pnpm test:coverage`   | `unit/` with v8 coverage                        |
| `pnpm test:coverage:all` | All three tiers with coverage                 |

Each script is wired through its own vitest config (`vitest.config.ts`,
`vitest.integration.config.ts`, `vitest.e2e.config.ts`,
`vitest.all.config.ts`) — the include/exclude path filters live there,
not in glob args.

## Where to put a new test

Decide which tier by looking at the test's **dependencies**, not its
subject:

- **`unit/`** — mocks every collaborator that crosses an I/O boundary
  (LLM, filesystem outside `mkdtemp`, sockets, subprocesses). Runs in
  milliseconds. The vast majority of tests live here.
- **`integration/`** — exercises real code paths end-to-end with a real
  LLM call. Lives in its own folder because it needs `local.json`
  credentials (see `integration/README.md`) and is opt-in via
  `pnpm test:integration`.
- **`e2e/`** — spawns a full axiomate CLI process. Reserved for tests
  that need Ink rendering, REPL state, keybindings, stdin/stdout
  piping. None exist yet; see `e2e/README.md`.

Inside `unit/`, mirror the source path of the code under test:

```
src/utils/checkpoints/createSnapshot.ts
  → src/__tests__/unit/utils/checkpoints/createSnapshot.test.ts

src/components/MessageSelector.tsx
  → src/__tests__/unit/components/MessageSelector.test.ts
```

This keeps related tests grouped without forcing colocated `__tests__/`
clutter under every source directory.

## What NOT to do

- **Don't colocate.** No `src/<foo>/__tests__/`. That pattern was
  retired — every new test goes under `src/__tests__/unit/<foo>/`.
- **Don't put real LLM calls in `unit/`.** Mock `queryFastModel` /
  `queryModel` and assert on the arguments. If you need a real LLM, the
  test belongs in `integration/`.
- **Don't import test helpers across tiers.** A `unit/` test reaching
  into `integration/` (or vice versa) means a test type is confused
  about what it's testing.
- **Don't add new `.test.ts` files to `src/__tests__/` root.** The four
  files at the top level are pre-migration; they'll move into `unit/`.
  Put new ones in `unit/<mirrored-path>/` directly.

## Coverage

`pnpm test:coverage` (v8 provider) excludes `src/__tests__/**`,
`__mocks__/**`, and `*.test.ts(x)` from coverage instrumentation. The
thresholds are currently unset — record a baseline before enforcing.

## Migration status

The repo recently moved from a colocated-`__tests__/` layout. If you
encounter a stray `src/<foo>/__tests__/` directory, it's a regression
— grep for any matches and report.
