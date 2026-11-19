# Summary planning and deeper recovery

This continuation independently ports selected compaction planning from installed Claude Code2.1.326. Original executable/modules were never executed. Runtime observations concern tau with loopback dummy keys.

## Static provenance

Pinned SHA256: `e214ad76dcc0e846b03be28ed1c2734aacd4e27acb527cb7f8a9e2bed644e837`. Twenty-six bounded spans in eight complete hash-verified modules match the original executable: source `ev_bbb0f302193cfe2c12ce2e5537d83e76b056037df298de272f14a6f68657ed7b`, verification `ev_90a5e57cfae22cf8838c2d2c6301219b2401eadd86955e08be2cc80547a96a70`. Coverage includes the entire10518-byte s4n planner in two spans, grouping/split helpers, omission candidates/thresholds, default flags, head reduction, summary dispatch and outer deeper-pass guards.

Actual Ghidra12.1.4 matches26/26 spans in retained Timing program2.1.326: `ev_d09d41d8d0c63217dd4e0232f22eea76b7acb4976977ac6f92fffc3dbb17bb3d`. Marker: `COMPLETE requested=26 matched=26 failed=0`. This verifies recovered JavaScript provenance in nonexecutable Bun memory, not JavaScript decompilation or original runtime behavior. Ignored artifacts are in `artifacts/compaction-plan-pass/`.

## Conversation groups and summary scope

`src/compaction-plan.ts` separates planning from provider calls and transcript commits. A distinct assistant response ID starts a group. Incomplete-thinking resumption stays in its current group. Planning begins at the active boundary; old sessions without response IDs use local per-completion identities.

The ordinary plan summarizes an older prefix and preserves the latest reply group, including subsequent user/tool-result messages. Retained groups are excluded from the summary request. A positive supplied kept-tail allowance can retain more groups, accounting for estimated tokens and UTF8 excess over UTF16 length; it does not retain the opening groups wholesale. Full remote/media-specific extra-prompt-tail gates remain outside the port.

This corrects the earlier implementation which sent the entire active context to the summarizer and retained only pending input or a final tool pair. A two-group conversation has no older assistant prefix. Below the blocking threshold, proactive compaction can therefore skip it when last-resort summarization is not admitted. Blocked/reactive routes can use the last resort. Existing blocked-proactive fixtures now actually exceed the blocking threshold; a separate regression proves the nonblocking skip.

A first rapid refill below blocking can summarize all eligible rounds, matching the default refill policy. It does not need to wait for a second recorded rapid refill. The existing three-refill/failure breakers remain.

## Size-driven planning

When the original refusal provides actual/limit/gap counts and enough groups exist, the planner scales that gap against message estimates and system overhead. The initial split includes independently authored summary-instruction overhead.

If the summary request itself receives a context rejection, the round ladder increases the retained tail and sends a smaller prefix. Parsed gaps guide whole-group steps. With no parsed gap, the planner targets roughly a tenth of the prefix's estimate; steps always advance. Unrelated errors do not enter this ladder.

When the ladder runs out of assistant-bearing prefixes, an admitted last resort summarizes completed content while preserving pending plain user input. A completed tool-result tail can be summarized together with its calls; it is not detached or executed again. A whole-group head reduction can remove older summary-input groups, adding an independently authored missing-context notice when the new input starts with an assistant. At most three head reductions occur, and the final group is never dropped. Scratch omissions/truncation notices do not replace archived raw history.

The later [summary-result continuation](summary-response-contract.md) adds selected opening-round rescue and optional second-summary salvage. Media stripping, put-back attachments and richer substantive-content rules remain open. Fixed-prefix hcs is observed as a diagnostic at the traced call site; it does not justify inventing an unconditional early blocking rule.

## Optional tool-result omission

The recovered last-resort feature defaults on; grouped tool omission defaults off. An embedding may supply `compactionPolicy.omitLargeToolResults` to represent its feature assignment. No original feature/account service is queried, and no speculative CLI flag is introduced.

Candidates use unique tool-result IDs. Read outputs for the same resolved path form an atomic group; other calls form separate groups. A group must contain at least750 estimated tokens. An already replaced or duplicate member excludes the entire group. AskUserQuestion results and the recovered single-result denial categories are excluded. Tau supports string results; original media/unknown-size candidate handling remains unported.

For a known gap, total candidate tokens multiplied by four must cover it. Eligible groups are selected largest first toward1.1 times the gap; an unknown gap targets half the candidate tokens. The third omission pass selects all remaining candidates. There are at most three omission passes, only before head truncation and when fewer than three summary-input groups remain.

Only scratch summary-request results are replaced. IDs, calls and error flags remain intact. An independently authored notice says the call already ran, may have changed state, and its output is unavailable. Invalid/aborted summaries cannot commit those scratch replacements to the transcript. Original outputs remain archived after success as well.

## One deeper reactive pass

After a primary reactive summary, a second pass is eligible only when the retained active context still has at least three groups, or when a known gap and enabled tool-omission plan justify it. It must immediately follow that reactive compact. An accepted model/tool round or refused-prefill nudge ends that immediate opportunity.

The deeper pass is spent once. A third refusal surfaces even if three groups still remain. It does not add another rapid-refill count. Every summary/repair/retry still spends the same caller allowance; a preferred larger-model fork also retains its one-attempt child limit. HTTP rejections and summary planning attempts do not consume completed-round allowance.

The later [summary-result continuation](summary-response-contract.md) refines text validity to the recovered closed/open/missing-block rules and selected output-limited text acceptance. Transport-partial summaries remain uncommitted. Boundary metadata records groups preserved, total groups, head truncations, omission passes and omitted-result count. Retained assistant usage stays stored but is excluded from the new context anchor. These fields survive session save/restart and are projected out of API messages. Manual `/compact` now follows the full-active, no-tail path described in the later [summary-result contract](summary-response-contract.md); original cached-to-fresh fallback remains open.

## Verification and remaining work

The planning checkpoint passed **374 tests** (`ev_04fa4b22a8a79e66582af69306bec635adca3424d0028ca767455e6f28174e2b`) and typecheck passes (`ev_d6c0a877693abbeb1e5628303aba60f21f02fc0e6eefacc738feca248f99b0aa`). Coverage includes prefix exclusion/retention, gap scaling, UTF8 tail sizing, default-off grouped omission/exclusions, whole-group bounds, nonblocking skip/rapid refill, summary rejection ladders, two-pass/third-refusal/tool-transition guards, abort/global/child admission, scratch rollback, and compiled CLI retained-history restart.

A real12-column terminal fixture completes14 requests with clear/resume/output-cap reset and two reactive summaries. Retained groups shrink from two to one; the deeper pass does not increase rapid-refill counts. Summary text stays hidden, raw history persists and the CLI exits cleanly. Evidence: `ev_756623be602386d7750eeb5c0d88f55db01151f0e37ea699a353112b173a87c0`.

The later summary-result continuation adds selected rescue/validation/salvage and full manual scope. Remaining work includes complete cached-to-fresh summaries, media/attachment rebuild, precompute coverage/idle scheduling, hooks/classifiers/caches, richer remote/feature/model/account gates and complete SDK/provider recovery. See [request admission](request-admission-contract.md). The full reconstruction goal remains active.
