# Model-query recovery

This contract comes from static inspection of installed Claude Code 2.1.326, SHA-256 `e214ad76dcc0e846b03be28ed1c2734aacd4e27acb527cb7f8a9e2bed644e837`. No original executable or recovered module was run.

## Evidence and current implementation

Twenty bounded spans and containing module hashes match the original executable. Source: `ev_e351e9150a073910c2e39241c71141d4e5ffe21779efa50850cef910e6f24954`; verification: `ev_a975242f1d5d4f2adf426b7ed5906f9f649085b054c25557729f7289407e06e7`. Ignored verifier/results: `artifacts/recovery-pass/{verify-spans.py,spans.json,verification.json}`.

`src/recovery.ts` independently implements the complete recovered pure decision table, progress/cause classification, mutable query ledger, count rollback, dispatch admission, credential-renewal allowance and header escalation ledger. It accepts explicit policy/profile values; it does not fetch live feature assignments or credentials. `RequestAttemptLedger` and the provider now use it for pre-header and HTTP retry accounting, including suspension, header caps and persistent/background HTTP decisions.

Accepted-body recovery is now wired through the query ledger, explicit provisional text reset, reasoning/signatures, coherent-envelope completion, closed-block partial history, JSON body retry/fallback and ordered model fallback. See [the stream integration contract](stream-recovery-contract.md) for implementation, validation and remaining source gaps.

## Source boundaries

Most application spans are in `chunk-4h798pp0.js`. The ledger metadata retains executable offsets, lengths and hashes. Useful module-relative anchors:

| Anchor                        |           Offset | Meaning                                                  |
| ----------------------------- | ---------------: | -------------------------------------------------------- |
| `Fb`                          |          3114488 | Broad watchdog versus capacity-only scope                |
| `DXn`, decision helpers       | 3114820 vicinity | Fresh counters and pure recovery table                   |
| `GXn`                         |          3119324 | Query-owned mutable ledger and optional caller allowance |
| `lgs`, `zXn`, `dgs`           |   3121072 onward | Request/stream failure classification                    |
| `S9n`                         |          3122483 | Independent first-header failure retry cap, 1            |
| Header admission              | 3130912 vicinity | Check/increment before subsequent request recovery       |
| Suspended/reconnect admission | 3135859 vicinity | Separate extra allowances                                |
| `T1r`                         |          3149557 | Ordinary/persistent defaults and explicit override clamp |
| Query setup                   |          3234152 | Shared header count and model-call ledger construction   |
| Active stream recovery        | 3305299 vicinity | Progress classification into ledger decision             |

The typed setting bindings are separately verified in `chunk-07n5vvax.js`. Exact source spans are local evidence, not shipped application code.

## Settings and counters

Ordinary retries default to **10**, replacing tau's earlier independently chosen two. Nonpersistent `CLAUDE_CODE_MAX_RETRIES` accepts the recovered integer grammar and clamps at 15; negative/invalid input uses the fallback. `--max-retries 0–15` explicitly overrides the environment-selected limit for tau.

`CLAUDE_CODE_RETRY_WATCHDOG` enables persistence. Exact scope `capacity` retains the ordinary default/clamp but permits persistent capacity handling; other accepted/default scope uses a 300 ordinary-retry fallback and does not apply the 15 override clamp. The broad profile also removes the separate one-retry first-header cap. Caller cancellation and optional API-attempt admission still apply. Tau retains its documented 60-second computed wait ceiling, so long source capacity-wait behavior remains a gap.

Query counters are independent: ordinary retries, slept-through suspensions, reconnects, overloads, stalls, truncations, retries after thinking-only progress, output-filter retries, and a nonstream-admission flag. Policy includes separate maxima, fallback-model availability, foreground/background and persistent modes. Source fallback feature values allow up to `min(maxRetries,10)` slept-through retries, no extra reconnects, three overload observations, and one output-filter retry; live assignments may differ. Callers can supply recovered profile values explicitly.

The no-header count is separate from those counters. The first ordinary first-header failure increments it and arms escalation. A second fails in ordinary/capacity-only mode even if ordinary retry capacity remains. Suspension uses its own allowance first and does not escalate that header count. Each new model query starts fresh state, while its optional dispatch allowance can be caller-owned across queries.

## Stream classification

| Progress        | Source condition                                    |
| --------------- | --------------------------------------------------- |
| `nothing`       | No qualifying parsed event or output                |
| `started`       | Parsed events, no visible output or completed block |
| `partialOutput` | Output began, no completed block                    |
| `thinkingOnly`  | At least one completed block, no ordinary output    |
| `output`        | Completed block(s) and ordinary output              |

Cause precedence is denial, output filter, overload, server error/timeout, stall, connection loss (truncation before suspension), malformed stream, bad request, unknown. Coherent complete envelopes can suppress selected transport failures, including a missing final `message_stop`; tau now supports this complete-envelope path.

## Recovered decision rules

Decisions are retry streaming, retry without streaming, use fallback model, keep partial content, or fail. Selected rows summarize the complete implementation:

| State/cause                                           | Decision/accounting                                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Request suspended                                     | Spend slept-through allowance, then ordinary retry                                                   |
| Request network down                                  | Spend reconnect allowance, then ordinary retry                                                       |
| Persistent capacity refusal                           | May retry without ordinary count, subject to profile/background gates                                |
| HTTP 404, nonstream not yet tried                     | Admit nonstream, including at zero ordinary retries                                                  |
| HTTP 529                                              | Count overload; ordinary/persistent, background and model fallback policy compose                    |
| Denied                                                | Fail at every progress state                                                                         |
| Output filtered before output/stop reason             | One feature-controlled filtered retry, also spends ordinary retry                                    |
| Completed ordinary output                             | Keep partial for recognized transport/server failures; bad/unknown failure still fails               |
| Thinking-only stall                                   | One streaming retry; exhausted path keeps partial                                                    |
| Thinking-only connection/suspend/truncation/malformed | Up to two after-thinking retries; exhausted path keeps partial                                       |
| Thinking-only server error/timeout                    | Optional model fallback; otherwise two/one after-thinking retries; exhausted path fails              |
| Stall before any event                                | One streaming retry before nonstream fallback                                                        |
| Stall after initial events                            | Nonstream fallback directly                                                                          |
| Truncation before stop reason                         | One streaming retry before fallback                                                                  |
| Partial visible output suspension                     | Ordinary retry rather than extra suspension allowance                                                |
| Early server error                                    | Nonstream fallback; a sufficiently long failed stream can instead use after-thinking retry allowance |
| Partial output overload                               | Nonstream fallback with overload count                                                               |

Special counters alone do not guarantee a retry: ordinary retry capacity is checked too. Nonstream selection can consume one ordinary slot up to the configured maximum; it may still be admitted initially when that maximum is zero. A previously selected nonstream path can be selected again by the pure table while ordinary capacity remains. Application phase/history controls must govern actual dispatch; tau now connects these decisions to accepted-body recovery and JSON phases, with caller cancellation and shared admission.

The mutable ledger snapshots counts before stream decisions for rollback. Exhausted API admission changes a retry/fallback decision to fail, but does not prevent keeping existing partial content. Request shadow accounting preserves the nonstream flag; terminal stream decisions suppress later recounting until undone. Credential renewal has a separate two-admission budget, though actual credential refresh is not implemented.

## Verification and remaining work

Tests exercise all decision categories, counter changes, immutable input snapshots, persistent/background differences, classifier precedence, admission exhaustion, rollback, header caps and environment settings. Real HTTP tests verify the independent two-dispatch header cap despite a larger ordinary budget; a suspended first attempt plus ordinary first-header retry makes three dispatches; persistent429 can retry at zero ordinary budget; background529 fails immediately. All leave no timer behind.

Changing the default exposed a historical test that implicitly expected two retries and timed out under the recovered ten. Its test-owned process was stopped; the test now explicitly selects two for its three-dispatch exhaustion assertion, while default/configuration assertions verify ten. Baseline log is preserved under `artifacts/recovery-pass/full-tests-before-explicit-budget.txt`.

The subsequent [stream integration](stream-recovery-contract.md) completes those accepted-body, reasoning, rollback and model-fallback paths. Original authentication, cloud routing, capacity quota wakeups, full persistent wait policy, live flags and extreme unsafe integer overrides remain open. No original runtime/live service parity is claimed.
