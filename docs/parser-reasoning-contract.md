# Indexed messages, tool input and reasoning requests

This contract describes independent TypeScript behavior derived from the installed Claude Code 2.1.326. The original executable and recovered modules were never run. Runtime results below concern tau and loopback fixtures.

## Provenance

The pinned target SHA256 is `e214ad76dcc0e846b03be28ed1c2734aacd4e27acb527cb7f8a9e2bed644e837`. Twenty-six bounded source spans and their complete containing-module hashes match the target: source `ev_460f362ac7ba96319a412fd52b03fa30e7d13cdda144e98de561e3e9c48a00e1`, verification `ev_e69d55b61c9e2c190ec8661b7b5224673b53b9dfeb7ce06c6b3e337376cecd36`. The verifier and recovered source stay in ignored `artifacts/parser-pass/` and `artifacts/claude-bundle/`.

Actual Ghidra 12.1.4 also read all 26 spans from the retained imported program's nonexecutable `__bun` memory and independently matched every SHA256: `ev_b37cb778d1230628062ef1a441a249b2da0abb4f4e38b67b3fb6e6ab28e47ea7`. This establishes the bridge from recovered JavaScript to the native image. It is a memory-byte check, not JavaScript decompilation or a runtime observation. Earlier selected native decompilation passes remain documented in [the Ghidra investigation](ghidra-native.md).

`scripts/ghidra/InspectEmbeddedSpans.java` accepts a pinned manifest of file offsets, lengths and hashes; it checks section membership, nonexecution and the preferred-address mapping before reading. The report ends with `COMPLETE requested=26 matched=26 failed=0`. Reuse the existing Timing project and ignored runner instead of reimporting the large target.

## Indexed block assembly

`src/message-stream.ts` now maintains blocks by server index and tracks closure by object identity. Indices may be sparse, several blocks can be open, and a later start can replace an unclosed block. A closed text index may be reused. Committed content follows closure order, rather than index order or visible delta order.

Starts clear initial text, tool input, thinking and signatures. Only genuine deltas build those fields. Redacted data remains opaque. Test fixtures now expand convenient initial text/tool objects into empty starts plus deltas; direct raw-event tests independently verify that the production parser ignores initial values.

The latest-open pointer and terminal-stop flag follow the selected source: closure clears that pointer; block activity clears the terminal flag; a string stop reason sets it. Repeated stop-reason deltas overwrite the previous reason. A zero input-token update preserves a known positive count. Positive input updates and output-token updates replace previous counts.

Visible text can differ from closure order when blocks interleave or are replaced. Before successful completion, the provider reconciles provisional text with retained text through `onTextReset`. The CLI and sessions therefore agree on the authoritative committed answer. The same adapter already handles failed-attempt rollback.

Tau retains stricter validation around repeated message starts, missing/ill-shaped fields, post-stop events and duplicate committed tool IDs across indices. Its explicit message_stop checks also remain stricter than the selected source loop. Server-tool/image/citation blocks are unsupported. These constraints are not claims of original parser equivalence.

## Tool argument conversion

`src/tool-input.ts` normalizes accumulated tool JSON at closure and complete JSON response tool inputs. Empty strings and JSON null become `{}`. A leading BOM is removed before parsing. Valid JSON primitives and arrays survive conversion and reach the tool's own schema validation, which returns a tool error.

Malformed nonempty JSON becomes `{__unparsedToolInput:{raw,len}}`: raw contains at most 2,048 UTF-16 code units without a split high surrogate, and len is the original JavaScript string length. The original error calls this length bytes, although it counts code units. Tau's dispatcher returns one tool error for this marker and allows a later model round to repair the call. It does not replay the entire response or run the malformed tool.

Conversion strips only `__proto__` recursively; constructor and prototype fields remain data. The independent iterative copier avoids recursion overflow and handles repeated object references. Tool names are limited to 200 Unicode code points. Full original per-tool input repair hooks and tool-specific transformations remain unported.

## Model facts and output defaults

`src/model-facts.ts` contains factual IDs, numeric limits and booleans from the pinned shipped catalog. A literal-only TypeScript AST reader extracted the 24-model catalog without evaluation, imports or executing target code. The independent implementation uses these facts; the original catalog implementation is not shipped.

Pinned aliases resolve opus/sonnet/haiku to their shipped 5.5 IDs and fable to 5.2. Known older IDs resolve to the catalog's dated first-party wire IDs. This is a statement about installed bytes, not current service availability or account entitlement. Default model selection remains tau's existing `ANTHROPIC_MODEL` or `claude-sonnet-4-5`; account-selected defaults are not reconstructed.

Output defaults and upper limits are model-specific. Unknown first-party IDs use a 32,000 default and 128,000 upper bound; selected historical Claude 3 IDs use smaller limits. `CLAUDE_CODE_MAX_OUTPUT_TOKENS` selects a positive integer, caps at the upper bound and falls back to the model default for invalid values. The provider also bounds explicit `--max-tokens` against effective model/environment limits.

CLI default limits recompute for a resumed or interactively selected model and for each fallback model. Explicit max-tokens values remain explicit across fallback. Fallback candidates are deduplicated by resolved wire ID. Full provider routing, aliases with contextual suffixes, settings profiles, account allowlists and dynamically learned limits remain incomplete.

## Thinking selection

`src/reasoning.ts` supports this recovered first-party subset:

| Input                                 | Behavior                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `--thinking enabled` or adaptive      | Explicit enabled configuration; adaptive on supported models, otherwise a budget                                      |
| `--thinking disabled`                 | Explicit disabled configuration, subject to baked always-on model behavior                                            |
| No explicit mode                      | Truthy MAX_THINKING_TOKENS takes precedence over deprecated numeric CLI budget; otherwise default thinking is enabled |
| `--max-thinking-tokens N`             | Nonnegative legacy print-only budget; zero disables when no higher-precedence mode/environment value applies          |
| MAX_THINKING_TOKENS                   | Positive integer selects a budget; zero, negative or invalid truthy values disable the default                        |
| CLAUDE_CODE_DISABLE_THINKING          | Omits thinking from the request                                                                                       |
| CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING | Suppresses adaptive selection for Opus/Sonnet 4.6, as the recovered source does                                       |

Capability overrides from `ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL[_SUPPORTED_CAPABILITIES]` and `ANTHROPIC_CUSTOM_MODEL_OPTION[_SUPPORTED_CAPABILITIES]` support thinking/adaptive_thinking declarations. Tau handles matching IDs in this subset; full original model equivalence/routing rules remain open.

For budgeted thinking the selected budget is `max(1024, min(max_tokens - 1, model-policy limit, configured-or-model-upper-minus-one))`. Unknown assumed models have a 31,999 policy limit. The 1,024 floor is applied last, including when a caller chooses an unusually small output cap; tau preserves that source order rather than claiming such a body is accepted by a live API. Adaptive mode carries no budget. Historical models known not to support thinking omit it.

Baked catalog models that reject disabled thinking promote ordinary disabled selection to adaptive. The embedding-only mechanical option suppresses promotion; rejecting models still omit the unsupported disabled request field. The embedding-only alwaysThinkingEnabled option represents the corresponding configuration input without reading personal Claude settings. The later [thinking recovery continuation](thinking-recovery-contract.md) implements selected signed resumption, prefix repair and output filters. Runtime learning, effort, display/betas, effective context and complete provider/account profiles remain incomplete.

## Verification

At this parser checkpoint283 tests and typecheck passed; the [current handoff](HANDOFF.md) records later333-test validation. Tests cover raw starts, sparse/concurrent/replaced indices, closure order, repeated stops, usage merging, malformed/BOM/null/primitive inputs, prototype keys, Unicode bounds and12,000-level iterative normalization. Real HTTP/agent tests prove that malformed tool JSON returns one error and can be repaired next round, and that visible output reconciles to retained closure order.

Real HTTP fallback tests observe model IDs, limits and thinking recomputed per model. A compiled CLI test observes explicit mode precedence, environment precedence over deprecated budgets, disabled requests and alias-specific defaults at the HTTP boundary. Existing CLI/session tests verify signature replay and partial-history behavior.

Fresh genuine-delta PTY probes verify cross-turn Read/Edit staleness, clear/resume reset and clean exit (`ev_18682ab09523bb3fbf219630b72262ecf4bd5c4785d3b8e1216311daa7641ecd`), plus actual 12-column Unicode rollback and replacement-only history (`ev_a6d3a7c8ae788f14984ffc8966ba375c38273167b1ec675962a1d6c071ee1837`). The first updated budget fixture recursively normalized its own empty tool starts; that harness failed, its transcript is preserved, and bypassing normalization for already-normalized starts fixed the fixture. No application change was needed. The 75 ms CLI deadline probe also passes (`ev_4c468ffb292cfe3eff08c86d9b6c24d0e9b3df0616859129fcf5aaf4acc5106d`).

No original runtime comparison or live API behavior is claimed. Full reconstruction remains unfinished.
