# Thinking continuation and request repair

This continuation ports selected active coding-query behavior from installed Claude Code2.1.326 into independent TypeScript. The original executable and recovered modules were never run. Runtime observations below concern tau and loopback fixtures.

## Evidence

Pinned target SHA256: `e214ad76dcc0e846b03be28ed1c2734aacd4e27acb527cb7f8a9e2bed644e837`. Thirty-three bounded source spans and complete containing-module hashes match the original bytes: source `ev_4bc2b8f0ad497753a2d2b4201fe660afff49ac5b5a75e089bb24fc7dc0c43d16`, verification `ev_d3902c5bd4d1c3b41a3ffde1040899d987ba39e029224af650fbd8ed39ee65f8`. Ignored verifier/source/probe artifacts are in `artifacts/resumption-pass/`.

Actual Ghidra12.1.4 independently matches all33 spans in the imported nonexecutable Bun image: `ev_e6cf7d03682abe936f460648a3091de1d9eb8f7e780f8e8fe1eca882df87232b`, ending `COMPLETE requested=33 matched=33 failed=0`. Earlier23/30/32 reports are preserved. This is a static source-to-image bridge, not JavaScript decompilation or original runtime observation. The same pinned-image script and retained Timing project from the previous pass are reused.

## Output filtering and tool cutoffs

The source recognizes the exact phrase `Output blocked by content filtering policy` when the API error has unknown status or400. Its error-status helper excludes overload/rate-limit errors from that recognition. Tau's SSE classifier follows this distinction and checks the `dlp_request_denied` details code first. Escape-monitor/internal-stop predicates in this shipped build return false; no speculative detector was added.

An output-filter failure can retry streaming only before ordinary output is shown or any block finishes, and before a terminal stop reason. The default special allowance is one retry and still needs ordinary retry/admission capacity. It never switches to JSON or another model. A filter failure after provisional text, closed thinking or a terminal stop fails instead of retaining partial content. A later valid model refusal is a terminal assistant answer; it does not execute attached tool calls.

The distinct `tool_use_block_cut_off` details code ends the current response at the output limit. Tau retains closed blocks, drops open arguments/text, resets provisional display to retained text and enters the outer output-limit flow. Closed calls execute once with matching results; open calls never execute. This is separate from the malformed-but-closed tool JSON error marker described in [the parser contract](parser-reasoning-contract.md).

## Output-limit continuation

The active outer loop permits three output-limit continuations per prompt. Tau now continues a max_tokens response instead of failing immediately. Without closed tool calls, it retains the assistant response and appends an independently written continuation instruction. With closed calls, it executes them once and continues with their results. The original bundled continuation prompt is not incorporated.

The continuation count spans the prompt's model rounds and is independent of ordinary provider retry counters. The caller's max-turns and API-attempt allowance still bound dispatches. A fourth exhausted output-limit response fails with retained history. Refusal of a thinking prefill can switch to one text nudge without spending another output-limit continuation, matching the recovered outer transition.

## Experimental signed-thinking resumption

The source has two feature evaluations whose shipped fallback is false. Live assignments are not fetched. Tau therefore defaults to ordinary text nudges. Set `TAU_THINKING_RESUMPTION=true` or the provider constructor's thinkingResumption option to explicitly enable the reconstructed first-party path. This is tau configuration for the recovered capability, not an original Claude environment setting. `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` suppresses its beta header.

Resumption requires one thinking/redacted block, a nonempty thinking signature where applicable, a boolean server resumable=true, max_tokens stop, matching model identity and more than2,048 tokens of context headroom. Input, output, cache-read and cache-creation counts enter that headroom check. A fallback response from a different model uses a text nudge because tau's next query starts with the primary.

Only message_delta metadata establishes streamed resumability; message_start's resumable field is ignored. A boolean in delta wins over the event's top-level boolean, and absent/nonboolean updates preserve the last known value. The actual response model and resumable flag persist as local metadata. Complete JSON responses also supply these fields when valid. Positive cache counts replace known counts, zero does not erase them, and split cache creation counts can supply the total.

Enabled, supported requests send the shipped `thinking-resumption-2026-07-17` beta. A resume request preserves its trailing signed assistant block and adds no user nudge. Further resumed assistant responses carry local resumedFromIncompleteThinking metadata so the signed chain survives later session replay and model queries. Those fields never enter API messages.

The later [context continuation](context-contract.md) replaces the fixed200k adapter with recovered model/default/opt-in/runtime rules and cache-iteration accounting. An explicit contextWindowTokens embedding override remains available. Complete served-catalog/provider profiles, HIPAA/account services and dynamically learned identities/limits remain incomplete; the implemented subset does not establish live API acceptance or full resumption parity.

## Prefill refusal and beta rejection

Most4xx prefill refusals surface immediately to the agent, which falls back to a text nudge and omits orphan thinking from that next request. Authentication/transient statuses401/408/409/429/451 and explicit dlp_request_denied, claude_code_version_too_old or safety_monitor_blocked codes do not take this route. A resume-prefill prefix rejection never strips its signed prefill or switches to JSON.

A beta rejection needs HTTP400 plus the qualified header name: the message contains the beta and anthropic-beta/anthropic_beta, or a bounded `capability_rejected: beta_header:...` marker. Merely mentioning the beta name does not qualify. An ordinary request can retry once after disabling the header. A prefill rejection surfaces for the outer nudge. The refusal latch applies to subsequent provider instances in the same process.

Error metadata inspection keeps tau's existing65KiB/one-second/JSON bounds. Raw upstream messages are used only for decisions; user-facing errors expose a status and bounded internal code, not arbitrary upstream content. Original SDK handling of other body shapes remains a compatibility gap.

## Thinking-prefix repair

For a non-prefill HTTP400 whose message says thinking was not created in this conversation or is bound to a different conversation, the source can repair the request:

1. Parse anthropic-thinking-prefix-mismatch, bounded to2,048 characters. The first duplicate field wins. Block paths have the exact messages.N.content.N grammar with at most six digits per index.
2. Map the indicated wire block to a unique signed thinking/redacted key in effective local history. Already-stripped keys do not count as duplicates.
3. For the first two prefix failures, strip from that thinking ordinal through later assistant messages when the key is unique. Otherwise strip all remaining thinking. Later failures use the all scope.
4. Stop when no further change is possible. Healing does not spend ordinary retry capacity, but each new dispatch spends the shared API allowance. The two-target count survives accepted-stream retries and JSON phases; a new fallback-model query gets fresh state.

Stripping preserves meaningful text and tools, retains thinking before a partial boundary and removes selected thinking plus empty/whitespace text. A fully removed message gets a short placeholder. Direct consumers receive onThinkingStrip; the agent emits thinking_stripped and stores thinkingStripFrom metadata on affected messages. Original reasoning remains in local history while future wire projection honors the durable strip boundary. Callback abort/errors stop further dispatch.

The wire projector also drops unsigned, abandoned and orphan thinking-only messages; preserves valid resumed chains; and trims trailing whitespace/thinking when not resuming. Tau stores one assistant message per completion rather than the original's per-block event rows. Full original normalization, shared message-ID grouping, special placeholder/server-block behavior and concurrent streaming tool execution remain incomplete.

## Validation and remaining work

At this recovery checkpoint309 tests and typecheck passed: `ev_03a05b7e972cbd7489472bb81f1398884fbea896ac16874aa7d49be07a5f03a8`, `ev_5fe8436d6204fcc24ccef0bbed96cfb5a29eaf0f99d8adae25e65c3fa3ec6896`. The [current handoff](HANDOFF.md) records later333-test validation. Tests cover early/late filters, denial precedence, closed/open tool cutoffs, three-continuation exhaustion, signed chains, prefill refusal, unique/duplicate prefix mapping, two-target exhaustion across stream retries, admission, abort and qualified beta latches. A compiled CLI/session test verifies beta refusal→nudge→saved reasoning→resume→prefix strip, including process-latch reset and no local metadata on the wire.

Fresh genuine-delta PTYs pass cross-turn Read/Edit staleness/clear/resume/exit (`ev_360fc7185e60e193079f8dcb64a3147583ce75eb9e3778031a527d0922fe0086`) and12-column Unicode rollback (`ev_8ba08bae76f77d8ec78019470f56a2f9de09f7ca378ab79aafc5542faf7e61a1`). The compiled75ms header-timeout probe passes (`ev_a9e97477a206e39f602c374272e0838a30a95e3c105cd9d6a896a6fa7193a066`). One old test intentionally expected max_tokens to fail before any closed tool ran; its fixture was replaced after the recovered outer-loop behavior showed that expectation was incorrect. The first run's failure is preserved in resumption-pass/first-tests.txt.

Full reconstruction remains active: remaining context/budget and advanced compaction routing, complete auth/OAuth/cloud/capacity/quota/persistent waits, contextual fallback/refusal routing, complete settings/model profiles, MCP/hooks/plugins/subagents and original SDK/terminal breadth remain open. No original executable, recovered module, personal account data or live model service was executed/accessed for this work.
