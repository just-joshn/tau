# Async command hooks contract

Scope: settings and skill command hooks with `async: true` or `asyncRewake: true`, in tau's default CLI. Source is the pinned 2.1.326 bundle, read as data. Line numbers refer to `artifacts/claude-restored-2026-11-18/pretty/`. Needles live in `docs/async-hooks-needles.json`. Each occurs once in one bundle chunk.

## Data shape

| Model                               | tau                                                             | Source                                    |
| ----------------------------------- | --------------------------------------------------------------- | ----------------------------------------- |
| Launch handed to the owner at spawn | `AsyncHookLaunch` (`src/hooks.ts`)                              | `lY` → `fxt` call, chunk-4h798pp0 141654  |
| Store: pending map, held responses  | `AsyncHookOwner` (`src/async-hooks.ts`)                         | `lgn`, `wCr`, `BMe`, chunk-4h798pp0 43765 |
| Settlement                          | `AsyncHookSettlement` = killed, silent, response, wake, no-wake | `TCr`/`bCr`/`fxt`                         |
| Held answer                         | `AsyncHookResponse`                                             | `bCr` return                              |
| Delivered attachment                | `AsyncHookResponseAttachment` (`type: "async_hook_response"`)   | `uAs`, chunk-4h798pp0 137739              |
| Wake queue entry                    | `RewakeNotification`                                            | `tGn`, chunk-4h798pp0 44045               |
| Session queue entry                 | `{kind:"agent"} \| {kind:"hook-rewake"}` in `src/cli.ts`        | `Ya` → `Ch().enqueuePendingNotification`  |

Lifecycle of an `async` command: pending (spawned) → settled. A killed (cancelled, timed out, output bound, no exit code) or silent command leaves the store. A response is held, then the next `collect` delivers it once. `close` (source `removeAll`) drops pending and held entries. Rewakes never hold a response. They are tracked in their own set (source `tlo`/`$xs`).

## Behaviors

1. **When a command backgrounds.** `lY` (chunk-4h798pp0 141651): `(e.async || e.asyncRewake && zs) && !Pe`, with `zs = !ge() || ren()` (chunk-3zn9cw12 6271, 6366): interactive, or streaming input. A plain `--print` run therefore runs a lone `asyncRewake` hook synchronously, so exit 2 is ordinary blocking feedback. `async: true` backgrounds everywhere. `Pe` is `forceSyncExecution` (tau `HookRunOptions.forceSyncExecution`). tau: `asyncRewakeBackgrounds: interactive` in `src/cli.ts`, since tau has no streaming input yet.
2. **Hook name.** `EPs` (chunk-4h798pp0 143408): `Pt = h ? \`${Ct}:${h}\` : Ct`, the event plus its match query. The command label is `LI` (chunk-wxs36rx3): command joined with args.
3. **Reading the answer.** `bCr` (chunk-4h798pp0, `async_bCr`): `sgn` takes one JSON object after any leading `{"async":true}` line, falling back to each trimmed line. `agn` keeps a schema-valid object, else salvages `systemMessage`, numeric/boolean `metrics`, and `hookSpecificOutput` (dropping a non-string `additionalContext`). `Lj()` is `C().door !== undefined` (chunk-dqkaf9a9). The ordinary CLI has no door, so `HMe` is the unbounded `rgn` reader and `Zmn`/`egn` are identity. An empty answer with exit 0 and blank stderr holds nothing (`bCr` "no response payload").
4. **Killed commands.** `TCr` drops a killed command through `Sot`. tau treats `cancelled`, `timedOut`, `outputExceeded`, or a null exit code as killed.
5. **Delivery.** `nRs` (chunk-4h798pp0 135073) collects `async_hook_responses` through `uAs` only on the main thread (`Fe = !n.agentId`), on every attachment pass before a model request. tau: `createSessionHookHost(...).wrap().beforeModelRequest`.
6. **Projection.** Attachment renderer (chunk-4h798pp0 204214): one `isMeta` user message per text, `systemMessage` first, then `additionalContext`, each `tD(text)`, wrapped by `Qu` → `qs` (chunk-4h798pp0 202642, 202753) in `<system-reminder>\n…\n</system-reminder>`. History normalization merges it into the preceding user row. tau: `renderAsyncHookResponse`.
7. **SessionStart repeats.** `Oro` with `NCs` (chunk-4h798pp0 134742, 134730): skip an answer whose texts all appeared in the latest earlier SessionStart row for the same command.
8. **Rewake.** `fxt` asyncRewake branch (chunk-4h798pp0 140806): wait for the result, one `setImmediate`, read output, report. Then `hPo` checks exit 2 for an unopened script. `eGn` (64-entry map `gPo`) drops identical repeats. On exit 2: lead is `rewakeMessage` or `Stop hook blocking error from command "${hookName}":`, summary is `rewakeSummary` or `Stop hook feedback`, detail is stderr, else stdout. Exit 0 and 1 do not wake.
9. **Broken install.** `mPo`/`OCr`/`hPo` (chunk-4h798pp0 43953–44019): absolute script paths from shell words (`$HOME`, `~`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, interpreter split at a space). If every output line is `can't/cannot open <known path>` and no named script is readable, the wake says `… hook could not run: … cannot be opened …` with summary `… hook could not open <basename>` or `… needs quotes around a path with a space (…)`.
10. **Wake text.** `tGn` → `ji` (chunk-ystsg1m2): `<task-notification>\n<summary>${tn(summary)}</summary>\n</task-notification>` then `\n` + `qs(body)`, with `<` before `/task-notification` escaped. Body is `tD(lead + " " + detail)`. Entry fields: `mode:"task-notification"`, `priority:"next"`, `stopHookActive:true`, `skipAttachments:true`, `turnAttribution:"inherit"`.
11. **Wake in print.** The headless drain `park` (chunk-xt4nsgp1 5818) keeps running while the main-thread queue holds a command (`h = this.messageQueue.peek(dc)`), and async hooks are not tasks. A wake queued before the turn ends runs one more query. After the result, `Y$s` (chunk-xt4nsgp1 23843 → chunk-4h798pp0 140770) waits for unfinished rewakes at most `Bxs = 30000` ms, and nothing drains the queue after that. A rewake that ends after the final answer is waited for and never sent. tau: the turn loop in `src/cli.ts` commits queued wakes and reruns. `settleRewakes()` runs after a print prompt.

## Proof

- `test/unit/async-hooks.test.ts`: reader, salvage, settlement, script paths, broken install, wake text, store, registry launch seam.
- `test/integration/cli-async-hooks.test.ts`: real CLI, loopback provider, real hook scripts. Covers the async answer in request 3, a silent answer, the exit-2 wake as request 3, no wake on exit 0 or 1, a late rewake waited for and not sent, and a lone `asyncRewake` that stays synchronous.
- `scripts/differential/run_async_hooks.py <original|tau> <variant>`: the same variants in the verified profile.

## Not ported (known differences)

- `atExit:"leave"`: the original leaves unfinished `async` processes running at exit. tau's registry close terminates them.
- Progress intervals (`vMe`), `Bg` debug logging and SDK `hook_response` events, plugin `metrics`/`rewakeSummary` JSON (`nvt`, `IMe`, `uU`), account-memory withholding (`jxs`), `missingScriptThere`, `typeLabel`/`Z6t`, the plain-output SessionStart context branch, the `wot` confusable-tag scrubber (identity here), and the `ji` marker re-append (`Jh`/`qc`).
- `Oro` sees only earlier async SessionStart answers, not sync `hook_additional_context` rows.
- A sync hook that answers `{"async":true}` at runtime is not backgrounded.
- An interactive idle wake waits for the next prompt. The REPL does not start a turn by itself. A wake's `stopHookActive` does not reach the Stop hook input of the woken turn.
- Subagent hooks have no owner. Child `async` hooks stay plain background hooks, and agent-definition `asyncRewake` is refused.
