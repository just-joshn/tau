# Large Read admission and shared context room

Read accepts the optional boolean allow_large. In the active local agent it can raise byte/token limits using estimated remaining context. It shares claims with other raised reads in the same assistant reply. A new model round starts a new room; a user prompt containing several model/tool rounds does not keep one cumulative claim counter.

## Evidence

Twenty-three bounded spans from the pinned2.1.326 executable cover ru/Zp room creation, query continuation/reset, qT/Kce/B7 thresholds, Q$r/yvs admission, UHo/bRt counting and claims, model byte ratios/canonical IDs, and usage/held history. Source: ev_55ffc5fe0a6b57fdd96ec412836015859fc801534d30f60174cf0fa787878c6b; executable/module verifier: ev_cda862ee2ab9233b753e3a3c8caa85615f11633f3da8356309acaef87094fa43. Actual Ghidra12.1.4 matches23/23 nonexecutable __bun spans: ev_c430458442776ee4baa01003c059f975527d800dd8729a26e99d993fa568ca41. Reproduction files live under ignored artifacts/large-read-pass. This is static source behavior and byte provenance, not JavaScript decompilation or original execution.

Hyp28 is supported with its lifetime clarified to one model round. Findings51–53 record the selected conclusions. Earlier22-span reports precede the additional model canonicalization span.

## Recovered rules

The room holds a threshold, an API limit, a live held-history estimate and a claimed-token counter. Setup recreates it in each query iteration; compaction clears the old context field before subsequent setup. The direct API-key route avoids an additional subscription/credits threshold clamp that can apply to other original account states.

The threshold uses the selected context window minus min(model default output tokens,20000), then the recovered compaction threshold calculation (normally another13000 reserve). A positive percentage override can lower it. The model's default/environment output setting is used, rather than an individual request's --max-tokens or a learned response cap. A session compaction-window override is ignored when automatic compaction is disabled; the environment window can still apply.

For Read, normalized parent inputs include input, cache creation and cache reads. If those sum to zero, parent output alone is ignored; otherwise parent output is added. The allowance is:

    held = max(parent input/cache/output usage, history held estimate) + claims
    roomTokens = max(0, floor((threshold - held) * 0.7))

History held includes the source's cleared-input accounting. A room is unavailable for missing contexts, remote calls and inputs from another machine. If roomTokens is no greater than the base Read token cap, the allowance is not raised. Otherwise raised tokens equal roomTokens, and raised raw bytes equal max(baseBytes, roomTokens * modelBytesPerToken *3). The source uses4 for its named historical model set and3 for other resolved IDs; an absent model uses4.

Only explicit allow_large uses a raised allowance. Ordinary Read still has its base limits and may recommend an opted-in retry when the current room can fit the failed read. Opt-in without a raised allowance retains ordinary behavior. It does not unconditionally disable file limits.

Initially raised reads count numbered text, using at least ceil(UTF8 bytes/2) for the pre-count estimate. Above a quarter of the raised cap, the normal auxiliary model count can replace that estimate; count failure retains it. Selected range bytes are max(baseTokens*128, raisedBytes), not raisedTokens*128.

After counting, bRt recomputes the allowance before claiming. If still raised, its fresh token cap is used; if no longer raised, the original base cap is used. Only a successful initially raised read with a nonzero measured count claims tokens. Ordinary reads, failed reads and token pages do not claim. A whole-file overflow, including a post-count recheck failure, falls back to a page using the original base token cap. An explicit range instead errors.

This is an admission estimate, not strict reservation accounting: after losing its raised allowance, a read that fits the base-cap recheck can still claim it. A focused test preserves that source behavior even when another pending claim has consumed most of the room. No stronger no-oversubscription guarantee is claimed.

## Independent implementation

context-room.ts provides the room and allocation calculation. The agent creates a room for each completed main model round, captures the pre-reply history for held usage, passes current parent usage/model ratio/counting to its tool executor and clears that context after the reply's tools finish. All Read calls in the reply see the same claims. Its history estimate already includes cleared input accounting, so it is not added twice.

file-read.ts accepts lifted byte budgets, measures numbered text with the byte/2 floor, rechecks the current allowance, claims accepted tokens and retains base-cap paging behavior. tools.ts supplies independent hints for retrying with allow_large, insufficient room or unavailable large-read context. Complete visible raised text can populate the existing Read baseline; a page cannot. CLI auxiliary counts continue using a separate one-retry allowance outside generation --max-api-attempts. Room/allowance objects stay off API payloads and saved sessions; ordinary tool results remain in history.

Known/requested model identities use the independent resolver and source-derived byte ratio set, including dated historical IDs. Original cloud inference-profile and full account/host model resolution remain broader. The port uses its existing context-window/compaction policy subset; it does not recreate every original account/credits/client-data/remote window gate. The current product uses explicit API keys and does not inspect Claude account state.

The default base budgets and strict text/encoding/workspace rules still apply where no room is attached. Direct createTools embeddings can supply setReadContext; runAgent does so automatically. The agent currently executes validated tools after reply completion; original streaming tool start timing/concurrency and intermediate parent usage remain unported. Original deferred-tool catalog claims, nested agent/context ownership, connector/device/remote policy, special media reads and complete session/cache/default-limit services remain open. Write/Edit still have their separate64KiB existing-file bound; a successful300KB Read is not a claim that those writes are ported.

## Verification

All455 tests pass (ev_d3bb5e2785e0826ac648b1c84e12ad37e102654285db0522b18d65b85289db62) and typecheck passes (ev_659007f13221bb63eba14ed63bd5f40c7480738110ee198668d59600bd7eac33). Seventeen new tests cover parent/held/claim arithmetic, zero-input and iteration usage, ratios/caps, absent/remote room, boolean input, hints, numbered/UTF8 counting, actual reads beyond262144 bytes, selected bytes, shared exhaustion, concurrent post-count rechecks, base-cap fallback, cancellation, per-round reset/cleanup, cleared history and actual agent-tool composition.

An actual12-column11-request PTY passes (ev_2cf2e90c2ad64afbba2c052e17738815567fb4b1d7cbe18be392d64ee9c71735). It observes an ordinary byte refusal suggesting allow_large, two opted-in Reads in one reply where a300000-byte first read succeeds and the second uses a base-cap page, main-model numbered count requests outside generation allowance, clear followed by a complete large read, a complete smaller lifted Read permitting Edit, full/partial saved history, file mutation and clean exit. Eight generation requests and three auxiliary counts are observed.

Full CLI reconstruction remains active.
