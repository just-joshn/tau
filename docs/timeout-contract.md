# Messages transport deadlines

This is a static contract recovered from installed Claude Code 2.1.326 and independently implemented in tau. The original program and recovered modules were never executed. Runtime observations below apply to tau with local HTTP fixtures.

## Provenance

Target SHA-256: `e214ad76dcc0e846b03be28ed1c2734aacd4e27acb527cb7f8a9e2bed644e837`.

Thirty bounded spans, each at most 8 KiB, match the executable byte for byte. All nine containing module hashes also match the recovery manifest. Ignored verifier: `artifacts/deadline-pass/verify-spans.py`; results: `verification.json`, `spans.json`. Source evidence: `ev_ecad88181d3d31b9909abd612e2e7e18677fc19d9cefd45cccadf8872355087b`; verification: `ev_8a66d8866f1ee8683609744a633a1899073844833376b12c1fdd7fd265a9169b`. These establish control flow and fallback constants, not effective account/deployment feature values.

Selected original executable offsets (not module-relative):

| Contract                                | Module            |       Offset | Bytes |
| --------------------------------------- | ----------------- | -----------: | ----: |
| SDK fetch timer                         | chunk-vawgpkfg.js | `0x11450a26` |  1040 |
| Duration resolution                     | same              | `0x11477137` |   929 |
| First-header gate/window/sleep sampling | same              | `0x114775e0` |  1417 |
| Suspend classification                  | same              | `0x11477c8d` |   640 |
| Byte-idle wrapper                       | same              | `0x1147818e` |  1926 |
| Fetch/watchdog composition              | same              | `0x11478b66` |  3813 |
| Dual-clock timer coalescing             | same              | `0x11471767` |  1534 |
| Nonstream deadline                      | chunk-4h798pp0.js | `0x11a618f4` |   124 |
| Nonstream request/body scope            | same              | `0x11a61eb4` |  3402 |
| Active event configuration              | same              | `0x11a7f473` |   312 |
| Event progress reset                    | same              | `0x11a7da03` |   730 |
| Consecutive ping limit                  | same              | `0x11a7fe66` |   116 |
| Byte-to-ping heartbeat bridge           | same              | `0x11a63b2e` |   887 |
| Header retry window selection           | chunk-d73xe1mr.js | `0x11068fbe` |   372 |

Remaining verified spans cover direct-origin/request-ID gates, typed settings and number/boolean grammar. The ledger retains exact offsets/hashes for all thirty.

## Recovered layers

The SDK fetch timer is cleared when fetch settles, which normally means response headers. It does not bound an accepted streaming body. The active client supplies an application duration rather than relying on an SDK default. A separate no-response watchdog can expire before that timer. A nonstreaming request uses another linked controller around both dispatch and JSON body consumption.

Source fallback durations for a trusted direct provider:

| Layer                 |                             Fallback | Lifetime                                       |
| --------------------- | -----------------------------------: | ---------------------------------------------- |
| SDK request           |                           600,000 ms | Dispatch until response headers                |
| First-header watchdog |     180,000 ms plus upload allowance | Eligible request until response headers        |
| Byte idle             |                           180,000 ms | Stream creation or latest delivered byte chunk |
| Event idle            |                           300,000 ms | Stream creation or qualifying parsed progress  |
| Nonstream             | 300,000 ms local / 120,000 ms remote | Dispatch through complete JSON response        |

The source has provider, request-ID and feature gates. Tau implements the direct Messages provider: `api.anthropic.com` is trusted by exact URL host comparison, and an explicit `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` can opt a custom origin into that profile. Other custom URLs use a 300,000 ms byte fallback and have no first-header watchdog. Byte/event watchdogs still apply to their accepted SSE bodies. Tau does not fetch feature/configuration state; `resolveTimeoutPolicy` accepts caller-supplied configuration/features for independent embedding and tests.

## Settings

Tau resolves these once when constructing its provider:

| Environment variable                       | Meaning                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `API_TIMEOUT_MS`                           | Typed integer request duration; also the nonstream duration if positive                        |
| `CLAUDE_STREAM_IDLE_TIMEOUT_MS`            | Positive raw number overriding event-idle configuration; event duration has a 300,000 ms floor |
| `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS`       | Positive finite raw number overriding byte-idle duration                                       |
| `CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS`      | Positive typed integer overriding first-header base duration                                   |
| `CLAUDE_ENABLE_BYTE_WATCHDOG`              | Tri-state boolean, fallback enabled; also gates first-header and raw-byte heartbeat support    |
| `CLAUDE_ENABLE_STREAM_WATCHDOG`            | Tri-state boolean, fallback enabled; controls parsed-event deadline                            |
| `CLAUDE_CODE_STREAM_TIMER_SLACK_MS`        | Digits-only typed integer from 0 through 1000; fallback 0                                      |
| `CLAUDE_CODE_REMOTE`                       | Selects the shorter nonstream fallback                                                         |
| `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` | Explicit direct-profile origin override                                                        |

Byte and first-header base values clamp to 10,000–1,800,000 ms. Without a positive raw stream setting, valid remote `stream_idle_timeout_ms` values clamp at 1,800,000 before the event floor is applied. Remote duration fields must be integers from 10,000 through 2,147,483,647. A stream-setting override also changes the byte fallback, unless separately overridden.

Typed integer parsing accepts grouped decimal integers and integral scientific notation, then legacy decimal `parseInt` syntax for other strings. Raw watchdog settings use numeric conversion, with grouped-number fallback. Boolean forms are trimmed/case-insensitive `1/true/yes/on` and `0/false/no/off`; unrecognized input preserves the fallback. A nonpositive API setting maps the SDK timer to 2,147,483,647 ms but uses the ordinary nonstream fallback. It does not disable body watchdogs.

## Header windows and retries

Upload allowance is `ceil(requestBytes / 32768) * 1000` ms. The header limit is the positive API timeout minus 1000 ms, or infinity for a nonpositive setting. If that limit is below 10,000 ms, this watchdog is absent and the SDK timer remains authoritative. The initial window is the smaller of that limit and first-header base plus upload allowance.

After an ordinary no-response-header timeout, an eligible retry uses the finite header limit. With an infinite limit it instead uses the larger of base-plus-upload and 600,000-plus-upload. Each dispatch has fresh timer state. Source first-header suspension sampling checks wall time every second; gaps over five seconds accumulate, and a sum exceeding half the selected window classifies suspension.

Tau's existing retry/admission ledger still caps dispatches. Header failures can retry within that ledger. Accepted SSE can retry, select JSON/model fallback or retain closed blocks according to [stream recovery](stream-recovery-contract.md). JSON connection/deadline failures retry inside the current phase before text publication. Retry waits use the caller cancellation signal and do not retain an expired attempt's timers. See [retry](retry-contract.md) and [admission/fallback](attempt-ledger-contract.md) for narrower policy choices.

## Stream progress and clock handling

Every delivered body chunk resets byte idle. Each meaningful parsed event resets event idle and the consecutive-ping counter. Only the first thirty consecutive parsed pings renew the event timer; further pings cannot keep it alive forever. A ten-second bridge produces synthetic ping progress when raw bytes have arrived since the previous event/heartbeat, so SSE comments also help temporarily. Synthetic and parsed pings share the thirty-ping allowance. Neither raw bytes nor unlimited pings prove useful model progress.

Rapid progress can coalesce timer resets within the configured slack window. Wall and monotonic elapsed values must both be below slack, and wall elapsed cannot trail monotonic by more than five ms. The original scheduled callback extends by only the remaining owed interval, preserving the last-progress deadline. Byte slack is capped at 1% of its idle window; event coalescing is disabled when byte idle plus one second exceeds event idle. Heartbeat slack caps at one second. Tau has no `onRetryStatus` callback; the original also disables event coalescing when that callback is present.

On idle expiry, a monotonic shortfall exceeding half the idle duration together with wall-only elapsed time exceeding half classifies suspension. Ordinary expired inactivity produces a stage-specific sanitized timeout. Caller cancellation takes precedence. All header, idle, heartbeat timers and abort listeners are disposed on completion, failure or cancellation. Node's oversized-delay wraparound is avoided by scheduling finite delays in pieces no larger than its timer maximum; ordinary timers preserve native delivery so dual-clock suspension checks remain meaningful.

## Validation and remaining gaps

Controlled-clock tests exercise original multi-minute fallback values without shortening production deadlines: headers versus body, upload/escalation caps, independent flags, byte resets, thirty-ping exhaustion/reset, bounded raw-byte heartbeats, coalescing, suspension and cleanup. Local HTTP tests verify actual socket abort, retry admission, accepted-output non-replay, parsed ping exhaustion, cancellation, stalled JSON body coverage and disposal after success. Cancellation from the final JSON text callback now prevents a successful completion from being committed.

The compiled CLI before/after fixture sets `API_TIMEOUT_MS=75` and withholds response headers. Before: killed externally after 1.5 seconds. After: exits code 1 by itself with `Messages API request timeout after 75 ms`, no body/key disclosure. Logs: `artifacts/deadline-pass/cli-timeout-{before,after}.json`. This fixture executes tau, never Claude.

Final suite: **196 tests pass**, `ev_4ab2ec240d1d8a715097cd2a135745b2d8885fcbb8c02ea38748ce12c528ae07`; typecheck: `ev_3dca778e8f418d60a883d09f55711e7d3847a3ba7357d7149643910f5a0cf815`. CLI baseline/treatment: `ev_793ccaa761b96a9ebec39f8d046cc33c6de1d854c2c5c65235e817df8c04d7bf`, `ev_f254eec732cea4f3bfac5598f54fa1f57c9a26092f1aeebba6b922642fbf43a1`. Cross-turn PTY: `ev_3969ed406115183fdac404654ee8aad2264d9dee56cebe71759472c9479bcbca`.

Full original parity remains open: gateway/cloud/Bedrock request profiles, live configuration/feature assignments, dynamic settings changes, watchdog-driven model fallback and partial-stream recovery, richer event types, warning UI, and handling clock-read failures. Extreme/nonfinite raw stream durations and original Bun oversized-timer scheduling were statically accepted paths whose runtime scheduling is unverified; tau uses explicit finite chunking and no expiry for a nonfinite event duration. No original runtime or live service comparison is claimed.
