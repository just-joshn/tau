# Why tau's tests are built this way

This page explains the choices behind [the test strategy reference](TEST-STRATEGY.md). Each section names the evidence that settled the choice.

## Branch coverage comes from istanbul, not from Bun

Bun 1.4.4 reports lines and functions only. Its `lcov.info` has `FN`, `DA` and `LH` records and no `BRDA` records, so `bun test --coverage` cannot measure branches at all. tau needs an 80% branch floor, so `scripts/coverage/instrument.ts` instruments `src/**/*.ts` with `istanbul-lib-instrument` through a Bun runtime plugin. Babel parses the TypeScript directly, so the reported line and column numbers are the original source positions.

Three details decide whether the number is honest:

- The `bun test` runner process never fires `exit` or `beforeExit`. A first prototype that wrote coverage on exit lost every in-process count and reported 54.6% branches instead of the real 84.9%. The preload now writes from a global `afterAll`, and only CLI children use the exit hook.
- Most of `src/cli.ts` runs only inside child processes. `BUN_OPTIONS=--preload=<path>` makes every child `bun` process load the instrumentation. The `--preload <path>` form with a space breaks subcommands, because Bun reads `test` as a script name.
- A file that no test imports would drop out of the denominator. The runner instruments every source file before the tests start and seeds the map with zero counts.

Instrumenting in each child cost 1.26 s per CLI start with a cold cache. That cost alone pushed CLI tests past Bun's 5 s test timeout on small machines. The runner now fills an on-disk cache first, and children only read it, which takes 0.21 s.

## The 80% floor applies to every file

Before this work the suite already reached 84.9% branches in total, while 21 files sat below 80%. A total-only floor would have passed with `src/session-hooks.ts` at 32% and `src/cli.ts` at 56%. The strategy asks for per-file thresholds, so the gate checks the total and every file. The 85% line and function floors are total-only, as the strategy suggests after a baseline.

## The bunfig hygiene keys were replaced by code

The strategy's `bunfig.toml` sets `clearMocks`, `restoreMocks`, `unstubEnvs` and `unstubGlobals`. In Bun 1.4.4 those keys do nothing: a spy stayed patched into the next test, and Bun ignores unknown keys without a warning. The preload in `test/helpers/test-environment.ts` does the same job explicitly. After every test it calls `mock.restore()` and `mock.clearAllMocks()` and restores `process.env`. It also resets the three beta-refusal latches in `src/provider.ts`, which are process-wide by design and made results depend on test order.

## Tests were moved into tier directories

The tier scripts in the strategy need a way to select tests by tier, and a directory does that without a second registry. `scripts/move-test.ts` did the move and rewrote only real module specifiers, so the diff is renames plus import lines. Rerun it to place any new test file.

## The security corpus replays the real CLI

The P0 invariants are about what the CLI does: whether a file appears, whether Bash runs, whether a key reaches an output. The corpus therefore runs the real `src/cli.ts` against a strict mock provider. Each scenario is a versioned JSON file with a golden request sequence. Two findings came from it:

- A checked-in `.claude/settings.json` with `"defaultMode": "bypassPermissions"` started print mode in bypass, so a cloned repository could run Bash without approval. The original Claude Code refuses that mode from project and local settings (`REPO_UNGRANTABLE_DEFAULT_MODES` in its bundle). `src/launch-configuration.ts` now applies the same rule and falls back to `default`.
- Approved Bash commands inherit the API key. This matches Claude Code's default, so it stays a known gap for the owner to decide.

## The mutation check proves the guards are tested

Coverage shows that a line ran, not that a test would notice it changing. `scripts/mutation/run.ts` flips conditions, comparisons and boolean results in the four permission guard modules, one at a time, and runs the security tier against each change. The first run killed 65% of 440 mutants. New tests in `test/security/*-guards.test.ts` raised that to 98.9%. The five survivors cannot change behavior, and `scripts/mutation/equivalent.ts` records why for each one.

## The Node smoke runs a bundle

`src/` imports `.ts` files through `.js` specifiers, and Node's type stripping does not map them. The smoke therefore runs a `bun build --target=node` bundle of `src/cli.ts` under Node 26, which is the current Node LTS. That checks the claim the strategy cares about: the application uses only `node:*` APIs. tau does not declare Node as a supported runtime.

## Windows is not in the matrix

tau's README makes no Windows claim, and no Windows machine was available to verify one. A Windows job that is allowed to fail would show green while hiding failures, so there is no Windows job.

## The live evaluation never fakes a pass

`scripts/live-eval/run.ts` exits 2 with status `unavailable` when no API key is set, and 3 when a provider outage leaves the evidence incomplete. Policy compliance comes from the stream: a forbidden tool counts as executed unless tau marked it denied. `scripts/live-eval/compare.ts` gates a change on a paired bootstrap interval, not on one average.

## Verification status

These were run on the integration branch:

- On macOS with Bun 1.4.4: typecheck, lint and the format check passed. `bun run test` passed five runs in a row, with 1,555 passing and the one quarantined test skipped.
- The coverage gate passed with a cold cache, with a warm cache, at `--parallel=2`, and with six CPU-bound processes competing for the machine. The cold run at `--parallel=2` took 91 s.
- `bun run test:flaky` passed 7,745 of 7,745. Seeds 17, 101 and 419 each passed five full random-order runs.
- The mutation check killed 435 of 440 mutants in 311 s at concurrency 2. The other 5 are recorded as equivalent.
- The Node smoke passed under Node 26.13.1 on macOS and on Linux.
- In a Linux container built from `node:26-bookworm` with Bun 1.4.4, running as a non-root user on arm64, the suite passed three runs in a row and the coverage gate passed.
- actionlint, `bun audit` with the one exception, and gitleaks over all 87 commits reported nothing.
- Without an API key, `bun run eval:live` exited 2 with status `unavailable`.
- On GitHub-hosted `ubuntu-latest` and `macos-latest` runners, `verify.yml` passed every job. The first hosted run failed 8 Grep tests, because the runner images have no `rg` and the local container had one installed. Every job that runs tests now installs `ripgrep`.

These were not run:

- `nightly.yml` and `live-eval.yml` on GitHub. Their schedules start only from the default branch, so they first run after this work reaches `main`. Their step commands were run locally.
- The live evaluation against the real API, because no key was available.
- Windows.
