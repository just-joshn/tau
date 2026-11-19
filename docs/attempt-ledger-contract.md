# API attempts, billing decisions and JSON fallback

Thirteen bounded source spans and containing module hashes were verified against the pinned Claude 2.1.326 executable. Evidence: source `ev_eab3c6fb0243b2d4a6baf32907d79dd953dd0d5eb792e12e83d5f49af67afe85`, verification `ev_60ffe21cdebd6577ce6feea4da8659c6854aacefba22c5bd1a13b59bef733052`. Reproduce with `python3 -I artifacts/ledger-pass/verify-spans.py`. No recovered JavaScript was executed or imported into tau.

## Source-derived contract

| Boundary                                          | Executable offset | Bytes |
| ------------------------------------------------- | ----------------: | ----: |
| Pure attempt-decision policy and initial counters |         296053027 |  3384 |
| Shared ledger implementation                      |         296057553 |  1748 |
| Query's new ledger construction                   |         296172381 |   367 |
| Streaming fallback reuses ledger/options          |         296209064 |  1221 |
| 404 fallback entry                                |         296255490 |   847 |
| Nonstreaming dispatch with `stream:false`         |         296099508 |  3402 |
| Attempt admission before client/request work      |         296063779 |   130 |
| Billing and generic retry predicates              |         296085503 |  2283 |

`GXn` is created within each `Chs` model query. Its retry counters start fresh; an optional caller-supplied `apiAttemptsLeft` object can survive across queries. Admission decrements that shared count before client/request work, refuses at zero, and remains unlimited when omitted. Retry counts and total-attempt allowance are distinct. Both streaming and nonstreaming paths receive the same ledger and remaining retry capacity.

The original decision state also tracks reconnects, overloads, slept-through requests, stalls, truncations, thinking-only output and output-filter recovery. Some paths retain partial output or use another model. Those transitions are now implemented by the [query recovery table](recovery-contract.md) and [accepted-body integration](stream-recovery-contract.md).

An eligible 404 can switch to a nonstreaming Messages request. The fallback consumes capped retry capacity but can be admitted even when ordinary retries are zero. The original can also parse a JSON response under a non-JSON content type; tau deliberately requires JSON MIME. Original failure/admission decisions depend on other model, auth, route and stream state too.

Selected terminal decisions include `credits_required`/credit-required messages with exceptions, service spend limits, organization caps, DLP refusal codes and a policy-blocked error type. Subscription claim/overage headers alter some billing decisions. Static source establishes these conditions; no live account or billing behavior was exercised.

## Tau implementation

`src/attempt-ledger.ts` separates a caller-owned `ApiAttemptBudget` from one completion's `RequestAttemptLedger`. `--max-api-attempts N` selects a shared dispatch allowance **per user prompt**, across tool rounds, ordinary retries and opted-in fallback. Omission is unlimited; zero makes no request. Values are integers 0–1,000,000. The allowance counts tau fetch dispatches, not packets or a billing guarantee. It is fresh on each prompt and is not persisted with sessions. This CLI flag and cap are independent interfaces, not original flag compatibility.

Ordinary retries now default to10, with separate header/suspension/persistent admission. JSON fallback is enabled by default after eligible stream failures or404; `--no-nonstream-fallback` disables it. It does not override retry:false, and JSON404 cannot switch back to streaming. Both body recovery and fallback share query retry state and API admission; model fallback starts fresh per-model counters with the same caller allowance. See the current recovery contracts for the full decisions.

`src/http-error.ts` returns only policy decisions. It inspects eligible JSON error metadata within **64 KiB and one second**, applies the verified billing/policy subset, and never returns raw messages to CLI output. Oversized, malformed, non-JSON or timed-out metadata supplies no body information; status/header policy then applies. This is deliberately incomplete metadata coverage, not proof that an unseen refusal code is absent. Header-only terminal decisions and disabled retry paths avoid unnecessary body reads.

The provider changes only `stream:true` to `stream:false` in the fallback request. Each phase uses fixed serialized request contents. JSON responses are limited to 16 MiB and fatal UTF-8 decoding, validated completely before publishing text, and reject unsupported block types or duplicate tool IDs. Text/tool/reasoning blocks, stop reason and usage enter the same history/event path. JSON transport failures can retry in that phase before any text is published; malformed/oversized JSON still fails validation.

## Validation and gaps

The initial ledger slice passed **177 tests** and typecheck: `ev_5fa3dd1769d5a6a16e8989877ff75eb1f7c9c8162534157f6034fcd591ee903e`, `ev_217b404ff515de7dc8b34aa47584cfe52584ab1c1fc226c7d09fa7579248be84`. Initial allowance/billing regressions were observed failing: `ev_5fc7cd4b517258503cfe8d332636d338d09a124f317177db9a85c1b57b5ce21c`.

Compiled CLI fixtures verify allowance exhaustion after a retry and completed tool, preserved usage/history, resume with a new allowance, zero-request admission, and streaming → JSON tool response → streaming final response. Provider tests cover retry capacity across phases, refusal hints, credit exceptions, complete validation before text, duplicate IDs, cancellation, malformed/oversized/stalled bodies and size limits. These are loopback fixtures, not comparisons against original runtime.

Subsequent slices implement layered deadlines, partial-message retention, supported body retries and model fallback. Remaining gaps include full auth/cloud routing, quota wakeups/persistent waits, billing-origin checks and richer body schemas. Read the native clock report independently: no selected native caller is linked to this application ledger.
