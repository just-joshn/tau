# Test strategy reference

This page lists how tau's tests are organized, which gates block a change, and which risks stay open. It adapts the "Production test automation strategy for a Bun CLI agent harness" (version 1.0, 2026-11-17) to tau. For the reasons behind each choice, read [the test strategy decisions](test-strategy-decisions.md).

## Commands

| Command                                  | What it runs                                                                       | Blocks a PR             |
| ---------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------- |
| `bun run typecheck`                      | `bun check` over `src`, `test` and `scripts/**/*.ts`                               | Yes                     |
| `bun run lint`                           | oxlint with type-aware rules                                                       | Yes                     |
| `bun fmt --check`                        | formatting                                                                         | Yes                     |
| `bun run test`                           | every test file, `bun test --parallel`                                             | Yes                     |
| `bun run test:<tier>`                    | one tier directory, for example `bun run test:security`                            | No, `test` covers it    |
| `bun test --check --parallel`            | type-checks the tests and what they import, then runs them                         | Yes, on Linux and macOS |
| `bun run test:coverage`                  | the suite under istanbul with the branch gate, see [Coverage gate](#coverage-gate) | Yes                     |
| `bun run test:node`                      | builds `src/cli.ts` for Node and runs the bundle under Node                        | Yes                     |
| `bun audit --ignore=GHSA-fc5q-39xc-vjpf` | dependency advisories, with one dated exception                                    | Yes                     |
| `bun run test:flaky`                     | random order, seed 20261117, every file five times                                 | No, nightly             |
| `bun run test:mutation`                  | mutation check of the permission guards                                            | No, nightly             |
| `bun run bench`                          | CLI start-up and print round-trip timing and peak RSS                              | No, nightly             |
| `bun run eval:live`                      | the live evaluation against the real API                                           | No, manual or weekly    |

Every PR test runs offline. Tests talk only to `127.0.0.1` and never need an API key.

The Grep tests need a standalone `rg` in an absolute `PATH` directory, the same requirement the Grep tool has. CI installs `ripgrep` in every job that runs tests.

## Test tiers

Each test file sits in exactly one tier directory, directly or in a subfolder that groups related files. `test/unit/test-layout.test.ts` fails when a test file sits anywhere else.

| Directory          | Strategy tier | What belongs there                                                                                         | Files |
| ------------------ | ------------- | ---------------------------------------------------------------------------------------------------------- | ----- |
| `test/unit`        | T1            | In-process logic: parsing, policy, state machines, projections                                             | 66    |
| `test/contract`    | T2            | Provider, SSE, tool, MCP, hook and session adapters, often with real files, processes or a loopback server | 44    |
| `test/security`    | T3            | Permission decisions and the adversarial scenario corpus                                                   | 11    |
| `test/integration` | T4            | The real `src/cli.ts` process, in print mode and under a terminal                                          | 20    |
| `test/property`    | T5            | Seeded generated inputs and metamorphic checks                                                             | 5     |
| `test/faults`      | T5            | Faults at each phase of a provider or tool call                                                            | 8     |

To move a test file into a tier and fix its relative imports, run `bun scripts/move-test.ts <tier> <file>...`.

Shared test code lives in `test/helpers`:

- `cli-harness.ts` starts the real CLI in a private temporary home and workspace, with a whitelisted environment and a deadline that kills the whole process group.
- `mock-provider.ts` is a strict scripted Messages API server. A request beyond the script gets HTTP 500 and counts as unexpected.
- `pty.ts` runs the CLI under `Bun.spawn({ terminal })` for interactive tests.
- `scenario.ts` loads and replays the security scenario fixtures.
- `seeded.ts` is the seeded random generator. Set `TAU_TEST_SEED` to replay a property failure.
- `invariants.ts` is the invariant registry.
- `test-environment.ts` is the preload. After every test it restores spies, mocks, `process.env` and the provider's process-wide refusal latches.

## Gates

`.github/workflows/verify.yml` runs on every pull request and on pushes to `main`:

- `static` runs `bun ci`, typecheck, lint, the format check, `bun audit` and a gitleaks scan of the full history.
- `portable` runs `bun test --check --parallel` and the Node smoke on `ubuntu-latest` and `macos-latest`.
- `evidence` runs the coverage gate with a JUnit report, scans `coverage/` and `test-results/` for secrets, and uploads both only when the scan is clean.

`.github/workflows/nightly.yml` runs every day:

- random-order runs with seeds 17, 101 and 419, five times each
- a parallel run
- the mutation check
- the benchmark, uploaded and not compared
- a canary on the latest Bun, which does not block

`.github/workflows/live-eval.yml` runs on demand and weekly in the protected `live-eval` environment. It fails when the API key is missing.

Bun is pinned in `.bun-version`. A new Bun version enters only through the canary job and a deliberate pin change.

## Coverage gate

`bun run test:coverage` runs `scripts/coverage/run.ts`. The gate fails when any of these is true:

- a test fails
- total branch coverage is below 80%
- any single file in `src/` is below 80% branch coverage
- total line coverage is below 85%
- total function coverage is below 85%

The run counts every file in `src/`, including files that no test loads. It also counts code that runs inside CLI child processes, because the instrumentation preload reaches them through `BUN_OPTIONS`. The thresholds are constants at the top of `scripts/coverage/run.ts`.

To find the uncovered branches of one file, save a full run and merge a focused run into it:

```sh
bun run test:coverage
cp coverage/coverage-final.json /tmp/full.json
bun scripts/coverage/run.ts --focus src/read.ts --merge /tmp/full.json -- test/contract/read.test.ts
```

The focused run prints each uncovered branch as `src/file.ts:line:column` with its kind.

Measured with `bun run test:coverage` on the commit that added this page:

| Measure                  | Before this work               | Now                                  |
| ------------------------ | ------------------------------ | ------------------------------------ |
| Branches, total          | 84.90%                         | 90.28% (11,993 of 13,284)            |
| Files below 80% branches | 21 of 97                       | 0 of 97                              |
| Lowest file              | `src/session-hooks.ts`, 32.07% | `src/skill-hook-registry.ts`, 80.00% |
| Statements               | 90.63%                         | 94.57%                               |
| Functions                | 92.11%                         | 95.12%                               |
| Lines                    | 91.97%                         | 95.58%                               |

`src/skill-hook-registry.ts` sits exactly on the floor, so removing one of its tests fails the gate.

## Invariants

`test/helpers/invariants.ts` is the source of truth for the 15 invariants, their severity and their evidence. `test/unit/invariant-coverage.test.ts` fails when an invariant that needs tests has no test title naming it, or when a title names an id that is not registered. Name the invariant first in the title of every test that proves one, for example `INV-11 SIGINT during a Bash tool reaps its child and grandchild`.

| Id                                    | Severity | Evidence                                                                                               |
| ------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| INV-01 tool scope                     | P0       | security scenarios, `test/security/*-guards.test.ts`, `test/property/permission-decisions.test.ts`     |
| INV-02 tool arguments                 | P0       | `test/contract/tool-schemas.test.ts`, the malformed-input scenarios                                    |
| INV-03 untrusted text and permissions | P0       | injection scenarios, `test/security/repo-default-mode.test.ts`                                         |
| INV-04 secrets                        | P0       | key-leak scenarios, `test/integration/cli-process-contract.test.ts`                                    |
| INV-05 network egress                 | P0       | Not applicable. tau has no model-controlled fetch tool, and Bash egress is gated by INV-01.            |
| INV-06 workspace boundary             | P0       | outside-workspace, symlink and protected-path scenarios, `test/property/workspace-containment.test.ts` |
| INV-07 no replayed side effects       | P0       | `test/faults/fault-phases.test.ts`                                                                     |
| INV-08 tool result provenance         | P1       | `test/property/tool-result-pairing.test.ts`                                                            |
| INV-09 claims supported by evidence   | P1       | Live evaluation only                                                                                   |
| INV-10 budgets                        | P0       | `test/property/budgets.test.ts`, the max-turns scenario                                                |
| INV-11 cancellation and reaping       | P0       | `test/integration/cli-process-signals.test.ts`                                                         |
| INV-12 deterministic replay           | P1       | every scenario replayed twice against its golden request sequence                                      |
| INV-13 no false success               | P1       | `test/faults/fault-phases.test.ts`, the failure scenarios                                              |
| INV-14 isolated concurrent runs       | P1       | `test/integration/cli-process-signals.test.ts`                                                         |
| INV-15 Node portability               | P1       | `scripts/node-smoke.mjs`                                                                               |

## Reviewed fixtures

These files change only through review. CI never rewrites them.

- `test/fixtures/scenarios/*.json` are the security scenarios. `MANIFEST.sha256` pins their bytes. After a reviewed change, run `cd test/fixtures/scenarios && shasum -a 256 *.json > MANIFEST.sha256`.
- `test/fixtures/tool-schemas.golden.json` is the request contract of every built-in tool. When a schema changes, the test prints the difference. Update the file by hand after review.
- `evals/live/<subset>/*.json` are the live cases in four separate subsets: `development`, `regression`, `holdout` and `adversarial`.

## Known gaps and exceptions

Each known gap is a `test.failing` test whose title starts with `KNOWN-GAP`. The test passes while the gap exists and fails once the gap is fixed, so the fix must also turn it into an ordinary test.

| Gap                                                                                                                                                                                                                         | Invariant  | Test                                                | Decision needed                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------- | -------------------------------------------------- |
| A Bash command the user approved can read `ANTHROPIC_API_KEY` from its environment. Claude Code behaves the same unless `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`.                                                               | INV-04, P0 | scenario `bash-subprocess-does-not-inherit-api-key` | Add an opt-in scrub, or accept the parity behavior |
| A `tool_use` id that a later turn repeats runs the tool again.                                                                                                                                                              | INV-07, P0 | `test/faults/fault-phases.test.ts`                  | Track executed ids per session                     |
| `__proto__` and unknown keys are dropped instead of rejected. Write, Edit, Bash and Skill accept unknown keys. Agent accepts keys its advertised schema forbids. No tool input has a size limit unless its schema sets one. | INV-02, P0 | `test/contract/tool-schemas.test.ts`, two tests     | Strict schemas, or parity with the original        |
| A resumed session can send `tool_result` blocks for ids that were never issued.                                                                                                                                             | INV-08, P1 | `test/property/tool-result-pairing.test.ts`         | Drop unpaired results during history projection    |
| The retry wait uses real timers instead of the injected clock.                                                                                                                                                              | none       | `test/faults/fault-phases.test.ts`                  | Route the wait through the clock                   |
| A subagent's preloaded skill renders the parent's effort.                                                                                                                                                                   | none       | `test/integration/cli-skill-context.test.ts`        | Pass the subagent's effort at `src/cli.ts:780`     |
| An invalid option value prints raw validation JSON instead of one `tau:` line.                                                                                                                                              | none       | `test/integration/cli-process-contract.test.ts`     | Format option errors in `src/options.ts`           |

Other open items:

- `picomatch` 4.0.7 has advisory GHSA-fc5q-39xc-vjpf, a ReDoS with no fixed release. tau passes it only `claudeMdExcludes` patterns from settings files. A repository's project settings can therefore make tau hang at start-up, but cannot run code. `bun audit` ignores this advisory until 2027-02-17. The repository owner must approve this exception. Remove the ignore when a fixed release ships.
- One test is quarantined, see [Quarantined tests](#quarantined-tests).
- Every failure exits with status 1, including usage errors and SIGINT. The strategy suggests distinct codes, such as 130 for SIGINT. The tests pin status 1.
- Windows is not in the CI matrix, because tau claims no Windows support and nothing here verifies it.
- `verify.yml` passes on GitHub-hosted runners. `nightly.yml` and the weekly `live-eval.yml` schedule have not run there, because GitHub starts scheduled workflows only from the default branch. See [the verification status](test-strategy-decisions.md#verification-status).
- The live evaluation has not run against the real API.

## Quarantined tests

A quarantined test uses `test.skip` and a title that starts with `QUARANTINED`. Re-enable it as soon as its cause is fixed.

`test/unit/subagent-lifecycle.test.ts`, "real command registry preserves lifecycle matcher, JSON feedback and detached async delivery", timed out in about 1 of 15 parallel runs on a loaded machine. Bun 1.4.4 sometimes never delivers a child process's `close` event, even though the child has exited. The command hook in `src/hooks.ts` waits for `close`, so that run hangs. The same loss happens without any tau code. This probe hangs about once in 3,000 to 6,000 spawns when ten copies of it run at the same time:

```ts
import { test } from "bun:test";
import { spawn } from "node:child_process";

function run(): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", "console.log('x')"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => resolve(`HANG pid=${child.pid}`), 3000);
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    child.on("close", () => {
      clearTimeout(timer);
      resolve("ok");
    });
    child.stdin.end("{}\n");
  });
}

test("spawn pair", async () => {
  for (let i = 0; i < 2; i++) {
    const result = await run();
    if (result !== "ok") throw new Error(result);
  }
});
```

Re-enable the test when a Bun release passes this probe. If the hang also matters in production, a hook can stop waiting once its child no longer exists. That change belongs in `src/hooks.ts`.
