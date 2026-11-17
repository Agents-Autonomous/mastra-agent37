# Contributing

Thanks for helping improve `@mastra/agent37`.

## Setup

```bash
pnpm install
```

Node.js 22.13 or later is required.

## Checks

Run these before opening a pull request; CI runs the same ones:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm build
```

Unit tests need no network or credentials. `src/test-utils/fake-agent37.ts` serves an in-memory Agent37 API through the client's `fetch` option and runs exec scripts in a local `sh`, so the process, filesystem, and stdin scripts are tested for real. The process tests need Linux with `setsid`, `mkfifo`, and `timeout` (util-linux and coreutils), and skip elsewhere.

## Live tests

The integration suite creates real Agent37 instances, which spends workspace credit:

```bash
cp .env.example .env   # then set AGENT37_API_KEY
pnpm test
```

Rules for anything that touches Agent37:

- Read `AGENT37_API_KEY` from the environment. Never print, log, or commit it.
- Tag every instance a test or example creates with `metadata: { mastra_test: '1' }` and an id that starts with `mastra-agent37-test-` or `mastra-agent37-example-`.
- Delete what you create (`_destroy()` in `afterAll`), then confirm nothing leaked:

```bash
pnpm sweep:test-instances --dry-run
pnpm sweep:test-instances
```

In CI the integration job runs only when the `AGENT37_API_KEY` repository secret exists, and always sweeps afterwards.

## Changes

- Every change ships with tests and, when behavior changes, documentation (README and examples).
- Add an entry to `CHANGELOG.md`.
- Match the existing style: Prettier with the repository config, and oxlint with no warnings.
