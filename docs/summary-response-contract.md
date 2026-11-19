# Summary results, rescue and manual scope

This continuation independently implements selected summary-result and manual-compaction behavior from installed Claude Code2.1.326. Original code/modules were never executed. Runtime observations below concern tau and loopback dummy keys.

## Evidence

Pinned SHA256: `e214ad76dcc0e846b03be28ed1c2734aacd4e27acb527cb7f8a9e2bed644e837`. Sixteen bounded spans in two complete hash-verified modules match the executable: source `ev_9f62fd080d26f8ff51ca9d90d9b5f6b4c1496bcbe5bf205ed8908f5372c6240c`, verification `ev_19f50de24948a4aa451d17d74d6a29dae2a562cfc98609e2a7095461c4c13131`. They cover marker helpers, first-text selection, ojn repair, JUn/Sis rescue, secondary salvage, child exhaustion, complete6353-byte manual cDo, selected cached/fresh dispatch and flags.

Actual Ghidra12.1.4 matches16/16 selected spans in imported nonexecutable Bun memory (`ev_01d638a6a394de03c8e56bab25bda2842167520fea57b1bde549fce01a48db16`). Marker: `COMPLETE requested=16 matched=16 failed=0`. This proves recovered-source provenance, not JavaScript decompilation or original runtime behavior. Ignored artifacts are in `artifacts/summary-pass/`; initial15 report is preserved.

## Summary result rules

`src/summary-response.ts` distinguishes three factual marker states after removing the first complete analysis block. A closed summary block can occur inline. An unclosed opening summary tag is recognized at a line start with optional spaces/tabs. Other replies have no recognized block. Matching is case sensitive. Rendering removes one complete analysis block, replaces the first closed summary wrapper with a simple heading and collapses extra blank lines. Original prompt/wrapper text is not incorporated.

The selected original helper takes the first text block of its chosen response. Tau now follows that selection rather than concatenating every text block. Thinking-only, empty-first-text and tool-call responses do not become usable summaries. The port still rejects transport-partial summaries; complete original SDK/fork partial-return behavior remains unverified.

The source permits open blocks and can accept output-limited summary text. Tau therefore accepts supported max_tokens text with an open block rather than universally requiring a closed block/end_turn. Closed blocks remain required by the opening-rescue and optional-secondary acceptance rules below. This corrects the earlier port's stricter blanket rule.

For an ordinary automatic/reactive reply with no recognized block, the default path can ask once more. The retry receives the original summary input with independently authored formatting instructions, rather than appending the previous candidate as conversation. Without an explicit compaction child scope, this repair has one dispatch total and still debits the caller allowance. It cannot create more ordinary network retries or bypass the caller's admission. An embedding can disable it with retryMissingSummary=false.

A successful marked repair replaces the first candidate. If repair fails or remains unmarked, ordinary scope can retain its first nonempty text. A bounded compaction scope rejects an unmarked result; an exhausted one-attempt larger-model fork does not gain another formatting dispatch. Open blocks need no repair. Manual full compaction does not use this automatic missing-block retry, although bounded manual scope still validates markers.

Known usage from both candidates is reported. Abort always prevents commit/salvage. Callback failures are not silently treated as model failures whose result can be salvaged. These rules remain distinct from the [size-planning ladder](compaction-planning-contract.md).

## Opening-exchange rescue

Before dropping a large substantive opening exchange, the original planner can summarize that opening alone. Eligibility requires its estimate minus a rounded-up tenth to cover the known reduction requirement plus70000 tokens. The margin derives from20000 +5×5000 +25000. Tau implements the selected ordinary message forms; original API-error/attachment rows are not all represented in its schema.

Rescue can occur when the split ladder reaches the opening group or after an unreduced full-summary request receives a known size refusal. It is attempted at most once. A closed-block result preserves later groups verbatim. An unclosed/malformed/error result is discarded, and the planner proceeds to whole-group head reduction. A size refusal updates the normal gap path. Caller/child exhaustion cannot create another dispatch or commit an unusable rescue. Raw opening content stays archived even when later summary input must omit it.

## Optional second summary and salvage

With summarizeKeptRounds=true, a closed first round-summary can be combined with the completed retained tail in one follow-up. Pending plain user input stays outside that follow-up. The default feature assignment remains off; selected automatic routing only enables a supplied assignment for a blocked rapid refill.

A closed second result can replace the first and preserve only pending input. An error, size refusal, unclosed result or exhausted allowance can preserve the first valid result and its original tail. There is no third planning round for a failed optional follow-up. Missing-marker repair remains separately bounded. Cancellation prevents both results from committing. Boundary metadata records format repair count, opening rescue and whether the optional second result was used.

## Full manual compaction

The traced cDo path summarizes every active message and returns no original tail. Tau's manual `/compact` now follows that scope, replacing the earlier pending-input/tool-pair preservation policy. A nonempty single-user history is eligible; empty active history is not. Explicit manual requests bypass automatic-compaction breakers. A summary size rejection can drop whole head groups at most three times, with all requests sharing caller admission.

Successful manual, automatic and reactive commits now rebuild ReadState through supported file restoration. Complete fresh restored text can authorize Edit/overwrite; references, excluded paths and failed restorations cannot. Failed/aborted summaries preserve the prior state. See [file restoration](file-restoration-contract.md) for source proof, selected behavior and remaining original attachment/abort-order differences. The earlier unconditional manual reset was an intermediate implementation.

Original iqn also has cached-to-fresh fallback, conditional tools/thinking/system choices, credits/refusal/model cascades and attachment rebuilding. The later [fresh-summary continuation](fresh-summary-contract.md) adds selected full/manual cached-to-fresh dispatch, configured provider chains and no-fallback admission. Full account/default/credits/refusal/access/gateway choices and attachments remain open. Manual failure-state lifecycle, full SDK message normalization/partials, hooks, precompute coverage and account/provider services are not claimed complete.

## Verification

The summary-result checkpoint passed **390 tests** (`ev_fa6d83792510e5f3bd7dd9c333f4cec3ea16d36aa215d67b65fab068c6247fb0`); typecheck passes (`ev_bb5c36f2fa24bcb1c24a9e61f9679b3ff0ae467ed16c4f9ea4ccde65d6de4eb3`). New tests cover marker/first-text selection, bounded formatting repair/fallback, child/global admission, open output-limited text, exact rescue margin/discard/size routes, optional second-summary success/salvage/abort/observer failure, and manual full/single-user/breaker/head-retry behavior.

An actual12-column terminal fixture completes18 requests: format repair, two reactive compactions, full manual compaction, cap clear/resume/reset, hidden summaries, archive persistence and clean exit (`ev_190007505c06304a9f2574f41d2eb341db3e445bb04257162e3dedafc9707487`). A separate7-request terminal fixture reads a file, manually compacts, observes Edit rejection, performs a fresh Read, successfully edits the file and exits cleanly (`ev_e2ce06400c38ba3ec0ce6f7545a2d4020647ef41ed5baac1ba40cc50478a371a`).

The full reconstruction goal remains active. See [summary planning](compaction-planning-contract.md) and [request admission](request-admission-contract.md) for earlier verified subsets and remaining provider scope.
