# Contributing

Thanks for helping improve `@agentsautonomous.ai/mastra-agent37`.

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

Unit tests need no network or credentials. `src/test-utils/fake-agent37.ts` serves an in-memory Agent37 API through the client's `fetch` option and runs exec scripts in a local `sh`, so the process, filesystem, and stdin scripts are tested for real.

Those scripts are written for Agent37's Linux instances, so the filesystem and process tests need GNU coreutils (`stat -c`, `timeout`), GNU findutils (`find -printf`), and util-linux (`setsid`). Linux distributions ship them. When any are missing, `src/test-utils/local-shell.ts` skips those two suites with a warning that names the missing tools; under CI (`CI` set) it fails them instead, so a runner without the tools cannot pass silently.

### macOS

Install the GNU tools with [Homebrew](https://brew.sh):

```bash
brew install coreutils findutils util-linux
```

You don't need to change your `PATH`: on macOS the test harness puts Homebrew's `gnubin` directories and util-linux's `bin` first on the `PATH` of the scripts it runs (it looks under `$HOMEBREW_PREFIX`, `/opt/homebrew`, and `/usr/local`), and leaves the rest of your shell alone. CI runs lint, typecheck, and unit tests on `macos-latest` too.

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
