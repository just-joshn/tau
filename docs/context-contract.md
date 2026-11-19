# Context windows and compaction

This continuation independently ports selected first-party context and compaction behavior from installed Claude Code 2.1.326. The original executable and recovered modules were never run. All runtime results below concern tau and loopback fixtures.

## Source and Ghidra evidence

Pinned SHA256: `e214ad76dcc0e846b03be28ed1c2734aacd4e27acb527cb7f8a9e2bed644e837`. Thirty-six bounded spans across eight complete containing modules match the original bytes: source `ev_b3b9081e1bc3201268cfb19fdc6f055fc6aa751dc9d47c57e4c0d76fb0d8f9f9`, verification `ev_03619bd19c53f73106b2599b47240e599073c01cb8fe5ecc89799af9fa6eac88`. The spans include the full baked catalog in three parts, window selectors, aliases, runtime bounds, token estimates, usage iterations/clearing, thresholds/breakers, compaction entry and boundary construction, and long-context beta retry.

Actual Ghidra 12.1.4 independently matches 36/36 selected spans from imported nonexecutable Bun memory (`ev_b2a1043844091e0ffd064ffe34c0cfa3de94656f9a512bd6667e43870c26e67b`). The report ends `COMPLETE requested=36 matched=36 failed=0`. Earlier 26/32/33 reports are preserved. This establishes static recovered-source provenance, not JavaScript decompilation or original runtime behavior. Ignored artifacts are in `artifacts/context-pass/`; the retained Timing project and pinned-image script are reused.

## Effective model windows

`src/model-facts.ts` now includes factual baked context metadata in addition to IDs/output limits. The catalog distinguishes200k defaults, native 1M models and explicit1M opt-in. Facts describe shipped bytes, not current service/account availability.

`src/context-window.ts` implements these recovered direct-provider rules:

- Known historical models generally use 200k; native 1M catalog models and the shipped preview identity use 1M. Unrecognized models default to1M unless1M is disabled.
- `[1m]` expands the selected model window and is removed from its wire ID. Family environment overrides still apply to qualified aliases. Native1M names do not need an implicit1M beta.
- The explicit context-1m SDK/environment beta can expand supported historical models. Historical exclusions and runtime-declared custom models have separate capability rules.
- `CLAUDE_CODE_DISABLE_1M_CONTEXT` disables opt-in/native expansion. Positive `CLAUDE_CODE_MAX_CONTEXT_TOKENS` ordinarily affects unknown models; together with DISABLE_COMPACT it becomes the strongest explicit window override.
- Supplied runtime input declarations are validated from 100k through 10M and bounded by baked no-opt-in caps. Sonnet4.6 client-data windows and authenticated intermediate-window assignments follow their selected source gates. Long-context credit blocking clamps to 200k, except for the strongest disable-compact override.

ContextPolicy supplies runtime/client-data/account/SDK-beta inputs explicitly to the independent provider. Tau does not read personal Claude state or fetch the original feature/account services. Full served-catalog identity routing, override maps, remote family inference, settings sources and all account/provider profiles remain incomplete. These explicit inputs represent the recovered selector's dependencies rather than claiming those services are implemented.

The agent now asks its provider for the effective window on each relevant round. This replaces the former fixed200k thinking-resumption default. An embedding's explicit contextWindowTokens still takes precedence. Native1M responses above200k can therefore resume when all other signed-thinking checks pass.

## Long-context beta refusal

Requests needing it send `context-1m-2025-08-07`, alongside the reconstructed thinking beta when applicable. A qualifying HTTP400 can resend once without the1M beta. The source distinguishes explicit references from a generic invalid-beta-flag guess.

Tau records a process/model refusal only when that resend actually begins a valid streamed message or completes a valid JSON message. A second400 does not prove backend rejection and does not disable the header on a later query. Suppression and the guess state span retries inside a query. Every dispatch spends caller API admission, while this header repair is distinct from ordinary retry capacity. A proven refusal changes future applicable window selection as well as headers.

The port currently handles the direct-provider route; gateway/third-party feature gates, full named-beta settings and every original feature assignment remain outside this subset.

## Context usage and estimates

`src/context-usage.ts` separates billing-style aggregate usage from the current context footprint. When aggregate input/cache usage is positive, it selects the last eligible message or fallback_message iteration, skipping trailing advisor_message/compaction iterations. An invalid final eligible record falls back to aggregate counts; it does not search farther backward for a convenient valid record. Cache creation/read and output tokens all enter the footprint. Aggregate usage itself remains available.

The message estimator rounds each supported block's UTF-16 character count divided by four. Text, thinking/redacted data, tool-result content and tool name plus serialized input are measured independently. Signatures are not included in the thinking-text estimate. Images, documents, task-delivery metadata and full original wire normalization remain unsupported by tau's block schema.

The latest usable assistant input/cache usage anchors the estimate; later messages use the character estimate. Zero input/cache usage does not become an anchor merely because output tokens are present. Supported server/client tool-clearing metadata contributes cleared input counts. Assistant usage and clearing data now survive local sessions and stay out of wire messages.

The newest compaction boundary resets context estimation and projection. Retained older tool-tail messages keep their observed usage in raw history but carry a local flag excluding that stale usage as an anchor after the boundary. New replies establish fresh anchors.

## Compaction admission and settings

The selected default math reserves up to 20k output tokens, compacts 13k before that effective window ends, and classifies blocking 3k before full API capacity after the output reserve. Warning begins another 20k earlier. For a 200k model with at least20k output capacity, the threshold math yields167k and177k. Routing determines whether those estimates proactively trigger admission: the direct default-auto window defers to server rejection; configured/native/unknown-enforced windows can compact proactively. See [request-admission-contract.md](request-admission-contract.md) for the later source-backed correction and larger-model exception.

`CLAUDE_CODE_AUTO_COMPACT_WINDOW` takes precedence over the embedding's autoCompactWindow. Environment token-size values use the recovered k/m suffix parsing and clamp to 100k–1M. The embedding also accepts numeric windows or shorthand strings. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` can move the compaction trigger earlier; `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` changes the blocking threshold. Sonnet5's selected local-agent/remote-cowork500k default is represented. Source client-data windows, richer settings maps and remote experiment tables are not fully wired.

Automatic compaction defaults on, as the recovered setting does. DISABLE_COMPACT, DISABLE_AUTO_COMPACT or the embedding's autoCompact=false disables it. `/compact` explicitly requests manual compaction. The transcript and API-attempt limits remain independent of context sizing.

## Summary transaction and sessions

`src/compaction.ts` implements a working summary path with an independently authored system/instruction prompt. No original system or compaction prompt is incorporated. The default summary fork preserves the parent system prompt, tool schemas and configured thinking, matching the recovered cache-prefix path, and uses the same caller dispatch allowance. Tool execution is denied separately: a returned call invalidates the summary and never reaches a tool executor. They do not publish summary text as normal answer deltas. Known summary usage still contributes to usage events.

The later [summary-result contract](summary-response-contract.md) refines accepted summary text: open/closed markers, bounded formatting repair and selected output-limited text can be accepted; transport-partial text remains uncommitted. Returned tool calls, empty answers and other invalid summaries do not execute tools or replace context. Cancellation before commit preserves the active transcript and does not spend a compaction failure count. Caller API-budget exhaustion is also a distinct terminal stop, without being counted as a summary failure or relabeled as context-full. An observer failure after commit does not relabel a valid summary as failed.

A committed boundary keeps the old prefix in local history. The later [summary planner](compaction-planning-contract.md) starts future requests with a summary plus retained recent reply groups, or pending input on last-resort paths; manual compaction follows the later full-active, no-tail policy. No pending tool-result tail is detached from its assistant calls. Boundary, usage, stale-anchor and compaction-state metadata persist in tau sessions but are projected out of API messages. A resumed CLI process honors the same boundary.

Compaction has a three-consecutive-failure breaker. Three rapid refills within fewer than three model rounds also stop further summary attempts. State persists with the session. On a proactive route, if enabled compaction cannot make room for a blocked request, tau reports a context-full error. A failed summary below that blocking threshold can leave the original context available for the normal request.

This is a baseline summary implementation, not the complete original compactor. The later [request-admission continuation](request-admission-contract.md) adds selected HTTP-reactive recovery, previous-larger-model fallback and output-cap admission. The later [summary planner](compaction-planning-contract.md) adds selected deeper reactive recovery, retained tails, size reduction and optional tool omission. Full larger-model gates and remaining nuanced source tail selection, fixed-prefix handling, precomputed/idle compaction, hooks, attachment rebuilding, classifier flows, full checkpoints and every fallback/retry interaction remain open. The local boundary representation is tau's schema. Compaction retains archived plaintext history and therefore does not lower the saved-session 32 MiB cap.

## Verification

The original context-only checkpoint passed **333 tests** and typecheck: `ev_f7d49f85d387429f26fcb92618596bb16a124ca40673821eee3e8a493cd6dea3`, `ev_ac99846ed8e7c5b95d51bbb56ed596d27b820f2a3ba6709716f53117e8046dfa`. New tests cover catalog/runtime/credit/override matrices, qualified aliases, native 1M resumption beyond200k, iteration/clearing semantics, token rounding/anchors, boundary-scoped prefix repair, thresholds/settings, summary tools/abort/admission, paired tails, observer errors, breakers and proven/unproven beta refusal.

A compiled CLI test with an explicit200k auto-compact window verifies old usage triggers compaction after resume, summary output stays hidden, raw history remains, new requests omit archived content, and another process restart honors the persisted boundary/state. Real terminal `/compact` and clean exit pass (`ev_20339526a6c8ac86e8d091e968f4822648c3da2911a491afc7d6a1f7b5ac1570`). Existing12-column rollback and staleness/clear/resume PTYs remain green (`ev_f8469d806dbca63c437aae9c37d12a10ab0fcddc913436c56040839412de84ad`, `ev_3a075afd7bdd2c20eba01510c49b6ec937ea271f36745860d0d04379301ff9a1`), as does the75ms header timeout (`ev_f92e7b4c477875ae1af96a79e252f556489b8c51cbf53af2519d6f0fa3629a58`).

Full reconstruction remains active. No original/module execution, personal Claude account data or live model service was used for these observations.
