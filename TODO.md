# Active workflow priorities

Full reconstruction remains unfinished. Current inventory: [subsystems and verification](docs/SUBSYSTEM-MAP.md).

- [x] Preserve existing work and map implemented/missing/verified major subsystems.
- [x] Port regular Write/Edit size guards and saved-byte verification (471-test checkpoint).
- [x] Integrate ordinary MCP stdio config→discovery→model call→rich result→save/resume→shutdown.
- [x] Consolidated MCP50/Ghidra50 and settings/SSE/bare58/Ghidra58 provenance;521-test checkpoint.
- [x] Verified disposable original/tau print/coding/failure/MCP-permission/lifecycle/SSE comparisons.
- [ ] Original/tau session and broader workflow differential coverage.
- [x] Source-backed explicit-root settings/instruction resolvers and21 disposable tests.
- [ ] Integrate layered settings/instructions/permission/MCP scope coding→resume workflow.
- [x] Correct observed SSE event-label/fallback and MCP in-place lifecycle mismatches.
- [ ] Original streaming tool scheduling and remaining full product gaps from the subsystem map.

Historical checkpoints below retain their original verification scope and test counts.

# Current continuation

- [x] Resume unfinished read-state work, reverify source and run fresh Ghidra metadata pass (4/4).
- [x] Resolve original guard-skip/complete-view unknown; document stricter tau guards.
- [x] Shared UTF-8/UTF-16LE BOM/encoding support and prefix-safe Read.
- [x] Quote/escape matching and style, empty-old-string creation, corrected mixed newlines.
- [x] 150 tests, typecheck, compiled CLI loopback flow and cross-turn PTY checks.
- [x] Trace active request configuration and independently port bounded pre-stream retries (161 tests).
- [x] Refine selected native stat calls with compile-checked syscall ABI annotations (4/4 baseline, 3/3 typed).
- [x] Trace per-query retry state and caller allowance; port shared admission, selected billing predicates and opt-in JSON fallback (177 tests).
- [x] Native clock/sleep passes: 4/4, 5/5 baseline, 5/5 typed; abort annotation removes initializer spill.
- [x] Verify 30 deadline/settings spans and port direct-provider header, byte/event and JSON deadlines with clock/suspend handling (196 tests).
- [x] Reuse Ghidra timing project: 2/2 sleep helpers, native flow proof and pthread_exit noreturn refinement (2/2).
- [x] Verify20 recovery/configuration spans and port the full pure decision table/query ledger; wire header/suspension/HTTP budgets (245 tests).
- [x] Actual Ghidra TLS terminal chain3/3 and trap-derived noreturn refinement3/3; conditional return retained.
- [x] Wire accepted-body recovery, provisional-output reset, thinking/signature blocks, ordered model fallback and partial finalization (266 tests, compiled CLI/session and narrow Unicode PTY).
- [x] Actual Ghidra network callers4/4 baseline and4/4 SDK-typed, compile-only Darwin ABI checks.
- [x] Verify 26 source spans and actual Ghidra embedded-byte bridge (26/26); port indexed starts/closure/input conversion and reasoning request defaults/capabilities (283 tests, compiled CLI HTTP and genuine-delta PTYs).
- [x] Verify33 continuation/repair spans plus actual Ghidra33/33; port output filters, tool cutoffs, three output-limit continuations, opt-in signed-thinking chains/prefill refusal, qualified beta latch and durable prefix stripping (309 tests, compiled CLI/session, PTYs).
- [x] Verify36 context/usage/compaction spans and Ghidra36/36; port model windows/1M refusal, iteration-aware usage and automatic/manual summary boundaries with failure/refill breakers (333 tests, CLI save/resume, actual /compact PTY).
- [x] Verify24 request-admission spans and Ghidra24/24; port tentative output caps, corrected default-window deferral, bounded reactive compaction and previous-larger-model child admission (356 tests, compiled CLI restart, real11-request terminal lifecycle).
- [x] Verify26 planning spans/eight modules and Ghidra26/26; port prefix/retained-group planning, gap/split/head reduction, optional grouped tool omission and one immediate deeper reactive pass (374 tests, CLI retained-history restart, real14-request terminal).
- [x] Verify16 summary spans/two modules and Ghidra16/16; port summary shape/repair, opening rescue, optional second-summary salvage and full manual scope/read reset (390 tests,18-request and7-request real terminal probes).
- [x] Verify15 fresh-summary spans/four modules and Ghidra15/15; port selected full/manual fresh bodies/shared admission/configured model routing, availability and global no-fallback (402 tests,8-request fresh/read-reset terminal and18-request regression).
- [ ] Complete remaining post-compaction attachments/retained-read lifecycle, account/default/credits/refusal/access cascades, strip/media/gateway/extra-tool gates, SDK partials, manual lifecycle and precompute/hooks/classifier/cache/product breadth. See docs/file-restoration-contract.md and docs/fresh-summary-contract.md.
- [ ] Full capacity/auth/stream-recovery composition remains open; see docs/attempt-ledger-contract.md.
- [ ] Full product parity remains open: context management, MCP, hooks, subagents, richer results and integrations.

Historical checklists follow; their unchecked staleness item was completed above.

# Finish the Read continuation

## Bug fix playbook

- [x] Reproduce it yourself on the matching surface via the control skill (Non-negotiables), even when a debug or instrumentation protocol says to ask the user to reproduce. Ask the user only with a stated, specific reason the control surface cannot reach the target, and only after driving it as far as it goes. If it won't reproduce directly, synthesize the trigger, tighten conditions, or instrument until it fires.
- [x] Binary-search the cause. Form the candidate hypotheses, then rule them out until one survives. Seed them with a trace of the affected subsystem and the **why** skill for regression history. Each pass, take the split that cuts the most remaining problem space, get runtime evidence, eliminate. When program state is unclear, add instrumentation or logging and read it as the code runs. Don't guess. Drive a long or stubborn hunt with `tmux_run` watchers and heartbeats that `wake` you. Confirm the surviving _mechanism_ with runtime evidence before the step-3 architect/interrogate fan-out.
- [x] Plan the fix. If it crosses a function boundary, `architect` first. Delegate implementation to a worker (`pi_spawn`) using your configured bug-fix model with a specific scope.
- [x] Verify on the same surface. The original repro now passes. "Inconclusive" or wrong-surface is not a pass. Flag it. Unit tests show branch behavior, not bug absence.
- [ ] Stage the commits so the failing repro lands before the fix in git history. See the **tdd** skill for the failing-test-first cadence when the bug has a cheap local test path. Skip it when the test would be expensive, integration-heavy, or unclear.
      skip: The application is untracked on main. A narrow failing-test commit has no committed dependency base. Baseline and treatment artifacts preserve the sequence locally.
- [ ] Run **Opening a PR**.
      skip: Publishing this fix would also publish the inherited reconstruction. Leave that separate publication decision out of this continuation.

## Throughput checkpoint

- [x] **Blocking first steps.** Capture the compiled CLI's UTF-8 output failure with a loopback-only API fixture before delegating a fix.
- [x] **Independent workstreams.** One worker edits only the existing output-bound function. Parent owns the CLI probe, docs, and evidence.
- [x] **Shared mutable state.** Source writes stay with the implementation worker until its report. Ghidra project writes are already complete.
- [x] **Smallest safe decomposition.** One owner suffices for the existing string-to-string helper. Its signature, callers, and ReadInput shape do not change.

## Resume point

- [x] Inspect actual Ghidra file-I/O reports with 4/4 and 5/5 completion.
- [x] Verify 17 original Read spans and nine recovered module hashes.
- [x] Implement bounded text line windows and confirm the offset/limit baseline and treatment.
- [x] Run 101 tests, typecheck, PTY interaction, and static target parsing.
- [x] Complete the added UTF-8 output-bound regression and CLI replay.
- [x] Review the local decision trail and write the Craft Anything handoff and evidence export.
- [x] Add the cross-tool `bounded()` regression from the trail review (102 tests pass).

The remaining data shape is `bounded(text: string): string`. It limits an encoded UTF-8 prefix, not UTF-16 string length. ReadInput remains schema-derived. The CLI probe confirms that decoding a byte prefix inside a code point caused the fault. The fix stays inside the existing helper. It changes no signatures or callers.

# Edit and Write

- [x] Native Ghidra write-path pass (8/8, 9/9 treatment).
- [x] Verify 17 bundled Edit/Write source spans.
- [x] Tau atomic write, replace_all, uniqueness, newline-on-delete, CRLF and BOM (119 tests, CLI probe).
- [x] Read-before-edit staleness. Original unknown resolved; see docs/read-state-contract.md.

- [x] Trace mtime-based post-compaction text restoration, prove19 spans with actual Ghidra, port candidate/reread/reference/cache rebuild and direct auxiliary counting (420 tests,10-request PTY).
- [ ] Remaining OHe attachments and unchanged-read/retained lifecycle.

- [x] Verify preferred larger summary preserves main Read count model (8 additional Ghidra spans,421 tests); separate restorationModel from summary model.

- [x] Verify active Read does not establish duplicate-read suppression; port256KiB/25000-token budgets, streaming ranges, adaptive pages and separate auxiliary counts (12 Ghidra spans,438 tests,10-request PTY).

- [x] Trace/port allow_large with shared per-model-round context room, numbered/UTF8 counting, fresh recheck/base fallback and claims (23 Ghidra spans,455 tests,11-request PTY).
- [x] Source-backed Write/Edit size expansion (16 Ghidra spans,471 tests,11-request PTY).
- [ ] Remaining account/deferred-tool/media/remote room policies and OHe attachments.
