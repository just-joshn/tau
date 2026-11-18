# Accepted stream recovery and history

This continuation connects the [recovery decision table](recovery-contract.md) to the real provider, CLI and sessions. It independently implements behavior recovered statically from installed Claude Code2.1.326. Original executable/recovered modules were never executed; all runtime observations below concern tau with loopback fixtures.

## Source evidence

Pinned target SHA256: `e214ad76dcc0e846b03be28ed1c2734aacd4e27acb527cb7f8a9e2bed644e837`. Thirteen bounded spans and their containing module hashes match the executable. Source `ev_68f8c5fc95a506979489c3e5b43319557b6940d995fdc386ce20ce134d95c9ee`; verification `ev_c645a20a50a066f0325e4812e24852a4c499f25036481150e89a5990a147200e`. Ignored verifier/artifacts: `artifacts/stream-pass/{verify-spans.py,spans.json,verification.json}`.

Active source boundaries include block start/delta/close, usage-only message deltas, coherent-envelope completion, closed-block partial finalization, streaming retry dispatch and final JSON fallback in `chunk-4h798pp0.js`. A verified CLI option in `chunk-g7cw7kap.js` specifies ordered comma-separated fallback models and retrying the main model at the beginning of each turn. Typed disable binding is in `chunk-07n5vvax.js`.

The source variable `dT` is a cache-state marker, not a display reset. Earlier handoff guesses about it were corrected before using it as a contract. Tau's `text_reset` is an independent consumer adapter for failed-attempt replacement, not an original wire event. The later [thinking recovery contract](thinking-recovery-contract.md) describes selected abandonment/projection, opt-in resumption, output filters and prefix repair.

## Query lifetime and retries

One `RequestAttemptLedger`/`ModelCallRecovery` now spans header failures, accepted SSE retries and the JSON phase. Fresh attempt-local parsers prevent mixed tool arguments, IDs, signatures or text across attempts. The optional caller-owned API allowance remains shared across all phases and model queries for a prompt.

Body failure classification selects streaming retry, JSON fallback, another model, keeping partial content or failure. Connection/truncation recovery and after-thinking retry limits follow the verified table. Stalled retries can be immediate; after-thinking transport retries use short waits, while server/overload retries use the recovered positive-jitter backoff. Caller abort wins over recovery, including abort from a reset callback. Consumer callback exceptions and independent byte-limit failures are terminal, without replay.

JSON fallback is now **enabled by default**, matching source fallback values. `--no-nonstream-fallback` or `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` disables it; the earlier `--allow-nonstream-fallback` remains an explicit compatibility spelling. Remote stream stalls suppress JSON fallback as recovered. Live remote feature assignments are not fetched. HTTP retry:false still stops fallback/retry, and a JSON404 cannot switch back to streaming.

JSON reads remain fully validated before visible text. Connection/deadline failures can retry inside the same nonstream phase, sharing ordinary capacity/admission. Malformed/oversized JSON fails. The original's additional nonstream timeout-specific allowances and route-dependent behavior are not fully implemented.

## Reasoning and envelope state

`src/message-stream.ts` supports text, local tool use, thinking and redacted thinking. Thinking text accumulates; a signature delta replaces the current signature. Initial thinking text/signature are reset as in the active source. Redacted thinking deltas are ignored; opaque redacted data is retained. Reasoning/signatures never call visible `onText`; valid blocks persist in local history. Wire projection now removes orphan/unsigned/abandoned reasoning, preserves valid resumed chains and honors durable prefix-strip boundaries.

Only closed blocks enter retained content. Blocks now support sparse/concurrent indices, open replacement and closure-order retention; initial text/tool fields are reset. Missing/closed index and wrong-type deltas still fail. Malformed tool JSON now becomes a bounded error marker and one tool error, allowing next-round repair without response replay. Duplicate committed IDs remain a stricter tau guard. Usage-only deltas update known counters without fabricating a stop reason; zero input updates preserve known positive usage. Repeated stop reasons overwrite earlier ones. See [the detailed parser contract](parser-reasoning-contract.md).

On recoverable partial finalization, closed blocks survive and open blocks are discarded. Stop reason is synthesized as tool_use only when retained validated tool calls exist, otherwise end_turn. Local partial metadata records the cause; the agent emits an incomplete-response warning. Closed retained tools execute once; open/unparsed tools never execute. Agent/history sequencing still creates a result for every committed call, including interrupted or unstarted calls.

Local `partial` and fallback `model` metadata are stored in tau sessions. Requests project messages to role/content so these local fields do not leak into the Messages wire format. Actual fallback model metadata does not change the session's selected primary model.

## Provisional output

`CompletionRequest.onTextReset(text)` replaces provisional text for the current model round. `runAgent` forwards it as `AgentEvent` type text_reset. CLI accumulation preserves prior committed rounds and replaces only the current provisional suffix. Direct provider consumers that display onText must honor onTextReset to revoke old displayed text.

Structured output emits the reset event and an authoritative final result. Print text buffers each round until commit, so discarded text is never printed. Interactive output streams immediately; a reset clears/repaints the current provisional region. Cell widths use pinned `string-width`9.0.0 for Unicode display columns, with grapheme iteration, wide-character wrapping, combining marks, emoji, tab stops and delayed wrap handling. The [maintainer API](https://github.com/sindresorhus/string-width#api) documents its display-cell measurement. Model-originated control/OSC sequences are stripped from text and replacements.

Terminal resize during an attempt, scrolled-off history and full original terminal rendering remain limitations. Current rollback assumes a column-zero attempt start, as the CLI arranges. It does not clear arbitrary prior scrollback.

## Model fallback

`--fallback-model model-b,model-c` selects ordered fallbacks. Entries are trimmed/deduplicated by resolved wire ID; the current primary is omitted from replacement candidates. Supported HTTP overload or thinking-only server/timeout decisions advance to the next model. Each model receives fresh per-query retry/header counts with the same caller API allowance. A new user/model round starts with the primary, matching the recovered CLI description. Model-specific output defaults and thinking requests recompute on fallback. Basic pinned catalog aliases are supported; full alias/provider routing, allowlists, server-side refusal routing, context-specific fast/capacity behavior and fallback-configuration inheritance remain incomplete.

## Verification

All **333 tests** and typecheck pass: `ev_f7d49f85d387429f26fcb92618596bb16a124ca40673821eee3e8a493cd6dea3`, `ev_ac99846ed8e7c5b95d51bbb56ed596d27b820f2a3ba6709716f53117e8046dfa`. Real HTTP tests verify signatures/redaction, partial connection retry/reset, shared body/header accounting, JSON phase retries, coherent EOF, closed-block retention, unexecuted open tools, callback cancellation, indexed/tool-input normalization, output filters/cutoffs, prefix/resumption recovery and ordered fallback with per-model reasoning. Compiled CLI tests verify prior-round preservation, one tool execution, reset events, no discarded text in saved/resumed history, reasoning replay/strip metadata, request thinking precedence, prefill refusal, plain print output and primary reset on a new turn.

A real PTY at **12 columns** emits a one-row rollback after `1234567890🌍X`, stores only `Replacement.`, respects a two-dispatch allowance and exits cleanly: `ev_f81b165eb3acdb88cf110cf93028d82f17e080239ff50d5b61fa390efe8ad1ef`. The first harness reached the correct rollback but did not drain/observe terminal exit; that transcript is preserved. The corrected harness drains PTY output and waits for exit as the existing harness does. No application exit fix was hidden in that probe.

## Remaining fidelity work

This is not full original CLI parity. Initial text/tool normalization, indexed lifecycle, repeated stops and first-party request reasoning follow [the parser contract](parser-reasoning-contract.md); selected output-filter/resumption/prefix transitions follow [thinking recovery](thinking-recovery-contract.md). Remaining work includes stricter tau envelope/duplicate-ID guards, extra server blocks/citations, remaining account/provider/served-catalog context gates and profile/runtime reasoning configuration.

Further gaps include original auth/OAuth/cloud routing, quota wakeups and complete persistent wait policy, advanced compaction routing, checkpoints, MCP/hooks/plugins/subagents, richer wire schemas and full terminal rendering. Independent resource/MIME/permission bounds remain documented. No original runtime or live service comparison is claimed.
