# Fresh summary fallback and model admission

This continuation independently ports selected full/manual summary fallback from installed Claude Code2.1.326. The original executable/modules were never executed. Runtime observations concern tau with loopback dummy keys.

## Static evidence

Pinned SHA256: `e214ad76dcc0e846b03be28ed1c2734aacd4e27acb527cb7f8a9e2bed644e837`. Fifteen bounded spans in four complete hash-verified modules match original bytes. They include the entire9205-byte iqn in two spans, configured/availability fallback helpers, thinking layers, fresh tool identities, the generator wrapper and no-fallback gates. Source `ev_a653e05a3880f820e1470790f961c216730df8b051e7520219c36093a65036c2`; verification `ev_0cb46d9cb27e12da4112bcb9375987d80956a9ce78ff210338ea5e72110275d6`.

Actual Ghidra12.1.4 matches15/15 spans in retained program2.1.326 (`ev_25c7a0e60c9fd453825edd68e30e262973ef1b632a418a533b6ada1c9b44e9cf`). Marker: `COMPLETE requested=15 matched=15 failed=0`. This verifies recovered-source provenance in nonexecutable Bun memory; it is not JavaScript decompilation or original runtime verification. Ignored artifacts are in `artifacts/fresh-summary-pass/`; initial14 report is preserved.

## Cached and fresh phases

The observed full/manual iqn first tries a fork that shares the parent's prefix. A usable cached reply can return directly. A missing/empty reply or error can enter a fresh request, except when cancellation or exhausted compaction admission prevents it. A cached size rejection can therefore try the changed fresh body before the outer manual head-reduction loop runs.

`src/summary-dispatch.ts` implements this distinction for tau's supported full/manual path. The cached phase retains parent system, tools and thinking. The fresh phase replaces the system text with independently authored summary instructions and uses the independent built-in Read schema by default. It preserves the configured thinking request. No original system or summary prompt is copied.

An embedding can set cachePrefix=false to start fresh, or supply freshTools as the resolved output of its extra-tool capability gates. Read remains first and tool names are deduplicated. The original extended branch includes ToolSearch/MCP and additional model/gateway/beta conditions; those services are not implemented or queried. A fresh Read schema does not execute Read: summary responses never reach a tool executor, and returned calls still fail tau's summary validation.

Fresh requests set an internal disablePromptCaching option. The direct provider removes protocol cache_control fields from tool definitions and message blocks. It preserves nested tool input data, including user data with the same key. The option itself is not sent as an API property. Tau does not yet implement the original complete prefix-cache construction, epoch and gateway policies; “cached” here identifies the parent-prefix phase, not a claim of complete cache equivalence.

The schema generator in tools.ts is now reusable without constructing an executor or touching filesystem state. This lets the fresh route supply the same independent Read schema even when the parent tool list lacks Read.

## Admission, retries and model routing

Every cached/fresh request, internal provider retry, repair and configured model fallback spends the same caller allowance. A one-attempt compaction child cannot gain a fresh dispatch. Global exhaustion remains terminal; a child-only stop can remain a failed summary under the existing parent policy. Known empty cached replies still contribute usage. Observer errors are outside the API-failure catch and cannot silently cause fresh requests. Abort before/during fallback prevents transcript commit.

The manual size loop can run up to four plans: initial plus three head reductions. Each admitted plan can contain a cached/fresh pair. The explicit fresh-only route still has at most four such plan requests. This replaces the earlier assumption that every manual size attempt necessarily made only one request. Reactive prefix summaries use their separate ojn-style path and do not inherit this full/manual fallback.

Fresh completions reuse the provider's finite configured model chain. A supplied modelAvailable callback can reject known unavailable entries before any dispatch. Alias wire identities are deduplicated by the independent provider. Boundary metadata records freshRequests and the effective requested summaryModel; main answer generation continues with its own primary model.

CLAUDE_CODE_NO_MODEL_FALLBACK=true collapses the provider chain to the primary. It also suppresses the earlier previous-larger-model compaction fork, matching the observed fDo guard. An unavailable primary then fails without dispatching a configured alternative. This closes a cross-route gap where the provider guarantee alone would not prevent the compaction router from selecting a different model first.

Original NHe/iqn additionally compose default ladders, account refusal/credits/access choices, host-model substitution, window-shrink checks and model-policy dialogs. Those branches are observed but remain unported beyond explicit configured models and supplied availability. StripNonEssential/media, special SDK result forms, remote/gateway gates and full lifecycle policies remain open. The port's body, session and error schemas remain independent.

## Verification

All **402 tests** pass (`ev_b47f6e320b7f06257f1a8bfa03823fadde89d7bc623e423cd36932e8c80d6bd6`); typecheck passes (`ev_26b291b69e61b7b67a3e02e3757f58e6811e6011bc345da0e30b4fe5cbaa6a97`). New tests exercise changed fresh bodies, empty/error/size cache outcomes, tool denial, explicit tools, cache-marker projection with nested data preservation, configured fallback and availability, global no-fallback including larger compaction, child/global admission, abort/observer behavior, bounded cached/fresh size pairs and separation from reactive planning.

An actual12-column8-request terminal fixture reads a file, receives an empty cached summary, succeeds with the fresh Read/system body, commits manual compaction, clears old read state, denies Edit until a new Read, then edits successfully and exits cleanly (`ev_48bc130e70f4c13b5bbded1d79f7b80d5e438909a6f287e63b2e8e45d35e5260`). The prior18-request format/deeper/manual terminal regression also passes (`ev_2f9d0d0b5c703fff780e3ba63566d86a5089c189a463371d1fff614f20d17853`).

Full reconstruction remains active. The next source-backed work includes restored file/read-state/attachment lifecycle and the remaining model/account/provider cascades. See [summary results](summary-response-contract.md) and [summary planning](compaction-planning-contract.md).

The later [file restoration pass](file-restoration-contract.md) supersedes the unconditional manual read reset described in the historical terminal fixture above. Full restored text now establishes a fresh baseline; references and omitted files still require Read. Its10-request terminal verifies cached/fresh fallback together with restoration, Edit, clear and resume.
