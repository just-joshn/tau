# Oversized requests and compaction recovery

This continuation independently implements selected request-admission behavior from installed Claude Code 2.1.326. The original executable and recovered JavaScript were never executed. Runtime verification concerns tau with loopback fixtures and dummy keys.

## Static evidence

Pinned executable SHA256: `e214ad76dcc0e846b03be28ed1c2734aacd4e27acb527cb7f8a9e2bed644e837`. Twenty-four bounded spans in six complete hash-verified modules match the original file: source `ev_c8c5686b561ab0fd883bcd41d80a2246793308af58e1cda07e93276d36b442e7`, verification `ev_8cb0e32e0c1c1caf6acf6d0ed0513acd7bd5dd44f2501f58603aca5a454c01fc`.

Actual Ghidra 12.1.4 matches all selected spans in the retained Timing project's nonexecutable Bun image: `ev_a6600360d1d71fe7c5edbd1daf6fd14975ea846a1a03e32e154df8550e416052`. Completion marker: `COMPLETE requested=24 matched=24 failed=0`. This verifies recovered-source provenance; it is not native decompilation of JavaScript or evidence of original runtime behavior. The earlier context36/36 and native decompilation/ABI investigations remain separate evidence.

Ignored `artifacts/reactive-pass/` contains the verifier, source spans, manifest, verification result, actual headless runner/report, tests and terminal probe. No recovered implementation or prompt is imported by tau.

## Output-limit repair

The observed `rbt` class distinguishes request repair from ordinary retry capacity. HTTP400/402/413/422/429 can supply an exact reported output maximum. Limits below4096 are not accepted as explicit caps. A candidate must lower the tokens actually sent. Where output defaults are assumed, selected otherwise-unclassified or combined input/output overflow errors can try32000. Billing and specialized errors have exclusions.

`src/output-limit.ts` independently represents one tentative repair per model query. The provider recomputes both max_tokens and enabled thinking budget for the resend. Every dispatch still spends the caller's API allowance; a repair does not create another ordinary retry. This state survives stream retries and JSON fallback, and a model fallback gets its own query state.

A validated streamed message_start or a complete validated JSON message proves the cap. HTTP200 headers and malformed message starts provide no proof. A second eligible rejection spends the repair and cancels pending learning; later success cannot retroactively prove that repair. Proven caps are keyed by resolved wire model within the provider instance. Aliases share the cap. A new provider, successful compaction, `/clear`, or successful `/resume` clears learned caps. Caps are not saved in session files.

The unknown-model thinking assumption is also conditional: a positive explicit CLAUDE_CODE_MAX_OUTPUT_TOKENS removes the assumed31999 thinking ceiling. The final thinking budget must still fit the actual output cap.

The original specialized-error callback is substantially larger than this port. Tau implements a documented conservative subset of its exclusions; security-control routes, served-model/output descriptors, account profiles, every specialized repair, and full host-latch reset behavior remain open. Explicit API error metadata is inspected with existing size/time/media bounds. Raw error strings are used for decisions and are not returned to the caller or stored in the transcript.

## Proactive and server-confirmed routes

The earlier implementation compacted every estimate above its threshold. Static `_cs`, `m0e`, `oNs`, and outer `Fl/Tf` gates show that this was too broad for the selected direct API route.

| Selected window source                                    | Admission behavior implemented                                    |
| --------------------------------------------------------- | ----------------------------------------------------------------- |
| Default `auto`, including ordinary historical200k windows | Defer estimate-driven compaction and blocking to server admission |
| Explicit environment/settings window                      | Use proactive threshold and blocking checks                       |
| Native/model-default window                               | Use proactive checks                                              |
| Unknown model with default enforcement enabled            | Use proactive checks                                              |
| Automatic compaction disabled                             | No automatic summary; enforce the local blocking limit            |

Threshold arithmetic remains documented in [context-contract.md](context-contract.md). A percentage override alone does not change the default source to a configured-window source. Tests which intend proactive200k compaction now explicitly set that window. Runtime profile recognition contributes to default source selection, while richer client-data/experiment/settings sources remain incomplete.

A blocked conversation can attempt a previously requested larger model even before the ordinary default-window deferral. This exception is described below.

## Reactive recovery and history

`src/context-error.ts` classifies specific prompt-too-long signatures, bounded capability markers, selected broad context errors, and combined input/output overflow. It retains only a typed category and safe numeric actual/limit/gap values. Broad matches exclude policy/DLP/output-filter/string-field-length errors. This is a selected HTTP path; converting every original SDK/stream error is not implemented.

When automatic compaction is enabled, a confirmed HTTP context rejection can request one reactive summary if active history has at least two exchange groups. Distinct assistant response IDs start groups; continued incomplete thinking stays in its group. Old sessions without response IDs use one local identity per completion. Groups begin at the active summary boundary.

A valid summary commits the existing transaction and retries the original model. Rejected HTTP dispatches do not count as completed model rounds, so a maxTurns1 request can recover. The same correction applies to refused thinking-prefill dispatches. Completed tool calls/results remain paired, and completed tools are not executed again. Summary usage contributes to totals; hidden summary text does not become answer deltas. Abort, global API exhaustion, invalid summaries and repeated rejection remain bounded terminal paths.

The source also has an optional deeper reactive pass when enough exchange groups or a gated removable-tool-result plan remain. The later [summary-planning continuation](compaction-planning-contract.md) implements prefix/retained-group planning, optional tool-result omission and one eligible immediate deeper pass. Complete opening-round rescue, media and secondary-summary behavior remain open.

## Previous larger model and attempt budgets

Observed `Scs` selects the last usage-bearing assistant's requested model, requires a usable usage anchor and blocked current context, and checks recognition, more usable capacity, model permission and account availability. It does not choose an arbitrary largest catalog model.

Tau persists requestedModel separately from served responseModel and responseId, excluding them from API message projection. `largerCompactionModel` uses the previous requested model only when it is recognized, has more usable context and is permitted. An embedding can provide `modelAvailable` / `Provider.canUseModel`; effective context selection already reflects supplied credit restrictions. No account or model-availability service is queried.

The larger-model summary receives one child attempt. `ApiAttemptBudget.child` debits its parent on every admitted dispatch, including retries, repairs and fallback. Exhausting only the child permits normal-policy fallback; exhausting the caller remains terminal and does not increment summary failure counts. A failed larger fork falls back to a normal summary on a proactive/reactive route, or returns a default-window request to server admission. Prior compaction failures suppress another preferred-model fork. Main answer generation still uses the requested primary model.

Full original account/quota/allowlist gates and feature assignments, manual larger-model selection, model-override flags, precomputed summaries, fixed-prefix classification, exact tail selection, hooks, fresh-summary fallback variants and attachments/checkpoints remain open. Local session/boundary structures remain tau's own schema.

## Verification

The request-admission checkpoint passed **356 tests**: `ev_3cbe7a116db7a5906561664e949ae53f3c53d9c873d153405643e9fc52401c34`; typecheck: `ev_fb4f5bf7e5b1876c39ed489ca651f19e6a4a220da237fc87dd0c42d17b71c258`.

Tests cover explicit and guessed caps, safe exclusions, tentative proof/refusal, JSON fallback, shared admission, unknown-model thinking overrides, default-window deferral, reactive maxTurns1 recovery, exactly-once tools, repeated rejection, one-exchange refusal, disabled compaction, abort, global exhaustion, child budgets, previous-larger-model fallback and availability, reset output reserves after summary commit, and compiled CLI save/restart of reactive boundaries.

A real12-column terminal probe completes11 HTTP requests: cap repair/reuse, `/clear`, `/resume`, server-confirmed reactive summary, cap reset after compaction, hidden summary text, original archived history and clean exit. Evidence: `ev_32680fcd0c1f062aec495bc83a8876ea9dcc0122c8a300bb4ee7a44fad41d942`.

The reconstruction goal remains active. These verified subsets do not establish complete Claude Code parity.
