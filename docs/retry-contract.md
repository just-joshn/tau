# Request retries

Eleven bounded spans and their module hashes were verified against the pinned Claude 2.1.326 executable: source `ev_2642a7dce68084c7b9a4c83b9190e0347582ec1bbbd85eba3e09a3d2f6a2616b`, verification `ev_28104f101c98a9b5782c1e8faae6a3e10a19ee4c9cad619a413f20e600febf7a`. Reproduce with `python3 -I artifacts/retry-pass/verify-spans.py`. No original code was executed.

## Original behavior, derived from source

The active coding-stream client is created with SDK `maxRetries:0` inside the application's `_je` generator. Messages create is inside that wrapper, which receives a shared model-call ledger and `retriesLeft()` budget. The SDK's default two retries therefore do not establish the active CLI policy.

| Boundary                          | Executable offset | Bytes |
| --------------------------------- | ----------------: | ----: |
| Active client construction        |         296213836 |   326 |
| Messages create and outer options |         296216755 |  1593 |
| Outer constants                   |         296060612 |   191 |
| Outer loop entry                  |         296063065 |   994 |
| Eligibility and budget selection  |         296085503 |  2761 |
| Ordinary delay-bound path         |         296079021 |   438 |
| Millisecond/date header path      |         293239926 |   709 |
| Application backoff wrapper       |         292143621 |   238 |
| Jitter math                       |         281829226 |   354 |
| Application retry-after parser    |         286202816 |    78 |
| Embedded SDK comparison           |         289738294 |   940 |

Ordinary application backoff starts at 500 ms, doubles, caps the exponential component at 32 seconds, then adds up to 25% proportional jitter. Server waits are also jittered upward and used as lower bounds. The SDK instead has a smaller cap and downward jitter.

The application combines generic retryable statuses with exclusions/recovery for auth, billing, safety refusals, routing, capacity waits, fast mode and fallback. Selected outer constants include 10 ordinary retries and a 15 clamp; other modes differ, and the active shared ledger is specified in [the recovery contract](recovery-contract.md). One ordinary path refuses excessive server waits; persistent/capacity paths differ. Full state composition remains open (`unk_2e485d24fec8a4cd`).

## Tau's independent subset

- Ordinary retries now default to **10**, matching the verified application setting. `--max-retries N` explicitly selects 0–15; zero disables ordinary retries. Suspension, first-header failures and persistent capacity have separate admission rules; see [the recovery contract](recovery-contract.md).
- Pre-header network failures and HTTP 408, 409, 429 and 5xx can retry. `x-should-retry:false` declines retries; `true` enables another error status. Redirects are neither followed nor retried, regardless of hints.
- Delay uses the application's 500 ms/exponential/32-second-cap/positive-25%-jitter shape. Positive `retry-after-ms`, numeric seconds or future HTTP dates provide lower bounds; milliseconds take priority. Invalid/nonpositive/past values fall back to backoff. Parsing is tau's explicit union of recovered forms, not identical to every original path.
- Computed waits over 60 seconds fail instead of waiting or retrying early. Fetches and waits honor cancellation. Error response bodies are canceled before retry and never exposed; the serialized request stays constant.
- Accepted SSE recovery now follows the verified progress table, using fresh parser state and explicit provisional-text reset before retry/fallback. Completed blocks can be retained with partial metadata. See [stream integration](stream-recovery-contract.md).

Retries occur within one model round; `--max-turns` does not count each HTTP attempt separately. Completed-response usage is not a billing ledger for failed connections. A pre-header failure can happen after the server accepted a request, so retrying can resend it. Persistent HTTP capacity/background rules and layered watchdog accounting are now implemented; ordered model fallback and accepted-stream recovery are now connected; original OAuth refresh, quota wakeups and the full persistent wait policy remain incomplete.

Later continuation: [the attempt-ledger contract](attempt-ledger-contract.md) adds an optional shared allowance across model rounds, bounded billing/policy metadata decisions and explicitly opted-in 404 JSON fallback. It records the new controls and how fallback shares retry capacity, including when ordinary retries are zero. The 161-test count below describes this initial retry slice; the continuation passes 177.

## Validation

New provider regressions failed before implementation (`ev_82bbb9ae73650fd78bcadd1ea3af4019a0c0d9d88d54e4513d319c5db2918044`). All **161 tests** and typecheck pass (`ev_35fb536295502937660099e4ebbdac04982346932069f57e6d86e6b574a6fd06`, `ev_090b73f8fb01444456663f3e87693cf35261e930b1b70d924a5c20ac13b51a7b`). Loopback tests cover success, fixed bodies, exhaustion, hints, cancellation, long waits, disconnects, partial-stream non-replay and redirects. Deterministic checks cover delay math and dates. Compiled CLI tests verify zero/one-retry budgets and redaction. No live model service was used.
