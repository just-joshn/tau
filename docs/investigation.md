# Local Claude CLI investigation

## Scope and method

Question: rebuild the core terminal coding-agent workflow independently in TypeScript, informed by the locally installed Claude CLI. Initial scope was static inspection only. The original executable was not run; `~/.claude/` credentials, settings contents, and personal sessions were not read. Ghidra being installed does not by itself recover the application implementation.

Craft Anything session started with no open project, Deep mode enabled, server 0.6.1. Investigation brief, plan, hypothesis, findings, unknown, and handoff were recorded in its session working memory. This file preserves the useful findings in the repository because that session is not a durable project file.

## Target

`~/.local/bin/claude` resolves locally to the version named `2.1.326`. The installation version label is also present in the recovered entry module's `Version: 2.1.326` comment (see continuation below); `--version` was not executed.

Craft Anything `core_target_open` detected Mach-O from contents, size 353,037,664 bytes, SHA-256:

```
e214ad76dcc0e846b03be28ed1c2734aacd4e27acb527cb7f8a9e2bed644e837
```

## Recorded findings

### 1. Native format and coverage — derived

Arm64 Mach-O; 27,228 discovered functions, 208,803 reported strings, 840 imports from four libraries. Discovery stopped at six million instructions; kept strings were capped at 200,000, 1,066 indirect jumps were unresolved, and local symbols were stripped. Counts do not imply complete application coverage.

Evidence: `ev_6c1f53ffa0b7fb9e71d0ed50af0fdba1111d9cf055d713945a460570dbf020f2` (`core_overview_show`).

### 2. CLI vocabulary — observed strings, not executed behavior

The target contains literal strings for permission modes, print/structured output, and resume flags. These initially justified borrowing familiar interface names; strings alone do not establish exact defaults, validation, or SDK compatibility. Later source recovery enables focused code tracing.

- `--permission-mode`, `bypassPermissions`, alias description for bypass: `ev_638d00076eea66c900c5c412b0906827787a6550db5227553cbf7d41dc9f3301`.
- `--output-format`, `stream-json`, descriptions mentioning `--print`: `ev_f3b0660d9ec521c45557f7681fd0906be094749dff15f97697e774929b1d248c`.
- `-r, --resume [value]`, related resume descriptions: `ev_c2c8f2fa7e652afbfad9f8d4817d860c220204c6afa9e07aba6a07ad64762f55`.

All three came from `core_feature_find`. The tool's generic `no_match` limitation appeared even when matching strings were returned: inspect the actual string results, not that misleading generic warning. No application-function references were recovered for these flags.

### 3. Bun wrapper — inference only

A search for `Bun` returned many runtime strings and runtime-function references, capped at 200 entries per category. This supports the hypothesis of a Bun-based executable wrapper; it does not prove that the original TypeScript/JavaScript source can be recovered from this file.

Evidence: `ev_15e3feb0884b7ead0680729ccd03b4814bd1bbfc88fc1cd2ef4dac9110d31e1a`.

**Analysis engine used in the initial pass:** Craft Anything's built-in static engine. At that stage, no Ghidra decompilation was run or claimed; the later focused Ghidra pass is documented below. Broad native-runtime disassembly would not establish the coding agent's application-level behavior. Application code had not yet been recovered in that pass; this changed in the continuation below.

## Implementation choices, not reverse-engineering findings

The provider uses the documented Messages API, not a recovered private protocol. Official API documentation was fetched through Context7 (`/websites/platform_claude_en_api`), covering streaming content deltas and stop events. Local HTTP tests verify the implemented protocol subset. Session format, permission policy, output schemas, prompts, and tool implementations are independent tau designs and intentionally do not claim exact original compatibility.

## Remaining unknowns

- Original runtime behavior and feature parity: no black-box differential run was authorized/performed.
- Original TypeScript, source maps, and full application orchestration: bundled JavaScript is now recovered, but its behavior has not all been traced.
- Live-model integration with an actual account: no real API request was made.
- Proprietary server, subscription authentication, MCP/hooks/plugins/IDE/cloud features: not implemented.

A future parity effort should specify one behavior at a time and compare it in explicitly approved, isolated runs of the original CLI. Do not copy personal state into fixtures, execute untrusted extracted code, or mistake runtime internals for application logic.

## Plan status and implementation handoff

1. Static target format/interface inspection — done, within the coverage limits above.
2. Independent core implementation — done: streaming provider, agent loop, six tools, permissions, CLI and separate sessions.
3. Local verification/documentation — done: `npm run check`, `npm test` (67 passed after the Ghidra continuation), `npm start -- --version`, and a temporary Python PTY harness (interactive help, mode changes, approval, write, reply, cancellation, status, clean exit). Local runtime was Node.js 26.13.1; minimum Node.js 22 was not separately exercised.
4. Full-product fidelity and live-service integration — open, not claimed complete.

## Continuation: direct bundled JavaScript recovery

### Payload layout — observed and derived

A separate `__BUN,__bun` section starts at file offset **129,744,896** and spans **222,249,315** bytes. The first little-endian u64 equals section length minus eight; graph pointers are relative to **129,744,904**, not the section start.

Evidence: `ev_d607500ebd6327e234b520c1601cbde48f6893cc0e4922c9fc24473165dbb6f3` (sections), `ev_1114024afcc7d9cd39735101858a230141fc920a45431a03d28f96bdf0f4cc27` (header).

The last 48 section bytes comprise a 32-byte footer followed by `\n---- Bun! ----\n`. Footer fields are: graph byte count **222,249,259**; module-table relative offset **222,043,801**; table length **177,320**; entry ID **7**; exec-argv offset **222,249,081**, length **177**; flags **0x3fff**. The table decodes as **3,410 × 52-byte** records, each with six offset/length pairs and four tag bytes.

Evidence: `ev_eca9b9d78c6244f945f649b80a11de775432db6e071c27bf2a530d6dd0dcd659` (footer), `ev_fe34e6e12bba7e0514023c588cfc23583851fa26c98b3a6b9b87cac6942497b6` (first records), `ev_76cb577d49d0906bb494cbf0c46bec4e1d804a400dc6ec3b3b7c2f9d25889ef7` (entry record).

Entry ID 7 has source contents at file offset **281,710,139**, length **27,943**. Direct bytes show JavaScript imports/functions and the version comment. This refutes a bytecode-only interpretation; original TypeScript and source maps have not been recovered.

Evidence: `ev_96062b6e4c05522d95697477674443dabf1c43c99d4326511a6ad5786881b1b2` (entry source), `ev_dd7ce276686f1d1f2398fd739ac83af49a7846fa499ce44be6cc9c12eb9ddd3f` (module 0 source).

The local inspector's complete summary is captured as `ev_efb1713b46c046e0290e69def25fee3d76349899c8bfc2d68a33a9fe65d51202`.

Independent bounded parsing found **3,150 JavaScript-loader records**, with **61,951,374 bytes** of contents, and extracted them statically into ignored `artifacts/claude-bundle/`. `artifacts/bundle-manifest.json` maps each to the executable offset, size, and SHA-256. These are local proprietary analysis artifacts, not tau implementation or redistributable source. No module was executed. The public Bun `StandaloneModuleGraph.rs` format informed decoding; checks against the actual bytes establish these target-specific coordinates.

The separate `__TEXT,__bun_aot` section contains `BUNAOTTB`/`BUNAOTRT` markers, but their presence does not establish that the application lacks source. Evidence: `ev_28fecf79c3634a5cbeb66099462020a7c71bba4883b5600b053c02ae41425a57`.

### Reproduce the static metadata inspection

```sh
npm run build
node dist/scripts/inspect-bun.js "$HOME/.local/bin/claude"
node dist/scripts/inspect-bun.js "$HOME/.local/bin/claude" --modules
```

`scripts/inspect-bun.ts` parses the Mach-O commands, Bun section, footer and module pointers. It validates bounds, alignment, entry ID and graph lengths. It emits metadata only: it neither executes the binary/modules nor extracts files. Tests use synthetic fixtures, every truncated prefix, malformed headers, footers and pointer ranges. This parser supports the observed arm64 Mach-O/52-byte graph layout, not every Bun platform/version.

### Tool availability/permission compatibility slice

Embedded help explicitly distinguishes `--tools` availability (including empty/default) from `--allowedTools`/`--allowed-tools` and `--disallowedTools`/`--disallowed-tools`. Evidence: `ev_e91514d18735aed392ac608a3a2cd8e0321943234c58ebe4a2d0da3c1600494f`, `ev_823f153f40b2d9d6342dd348d70dc6dfdb182c93b32d51957be0f2216efc6550`.

Tau implements an independent **exact-tool-name subset**, with availability/deny checked at advertisement and dispatch, explicit per-tool preapproval, and a hard plan-mode write gate. Original command patterns such as `Bash(git *)` are deliberately rejected. A focused source trace established availability versus preapproval and ordinary deny-before-allow behavior, with special-case exceptions. Original plan objections can ask with exceptions; tau's blanket plan-write denial is intentionally stricter. See [the source-derived permission contract](permission-contract.md).

Continuation verification: `npm run check`, all **62 tests**, local target metadata inspection, and the temporary interactive PTY harness passed. Captured verification artifacts: typecheck `ev_f20328585c0085e09bcb2ab4222e8f0cf7ca915e98b5150a5dde93a28e4081ac`; test output `ev_0ba5807786fad66b940b8cf5dbc185a4ae1b76a749a0f79de72b3aa0aa0aaefe`; PTY result `ev_22dfd0af337554f6b322f8696280f30771796079ffac90e540e2b472181b1880`. The CLI integration test now exercises preapproved writes and denial/empty availability even when the model requests hidden tools.

Review fixes included draining shell output before returning, marking nonzero shell exits as errors, bounding retained shell chunks, refusing oversized session saves before replacement, and accounting for completed API-response usage even if a later turn step fails. Tests cover the latter persistence/usage regressions.

Next work should use the recovered source to specify a remaining parity feature and its acceptance tests, or perform a user-approved live API smoke test. The original binary and `~/.claude/` remain untouched. Broad `Bun` searches return huge capped records; use saved evidence pages rather than repeating them. PTY harnesses must continue draining output while awaiting process exit: otherwise terminal backpressure can masquerade as a CLI hang.

## Continuation: actual Ghidra native analysis

At the user's explicit request, Ghidra 12.1.4 imported the full Mach-O without global auto-analysis and produced pseudocode for **13 selected native function entries**. The missing macOS ARM64 decompiler was built from shipped Ghidra sources in an ignored local copy; the managed install was not changed. A fresh-project pass verified the final script and SHA-pinned range manifest. No original code was executed.

The native section accessor and consumer corroborate `__BUN,__bun`, the eight-byte length prefix and 52-byte module records. Crucially, the leading length bounds the payload without requiring it to occupy the full section. The independent TypeScript inspector now supports trailing section padding, reports segment/pointer preferred virtual addresses, and distinguishes native `LC_MAIN` from JavaScript entry module 7. It rejects invalid native mappings and pointers into padding.

At completion of that loader continuation: typecheck, **67 tests**, real-target metadata parsing and the interactive PTY harness passed. Actual runtime parity remains unknown. Ghidra output has incomplete types/indirect flow; it is not recovered original C/TypeScript. See [the focused native report](ghidra-native.md) for exact evidence IDs, limitations, build instructions and reproduction commands.

That next application-level slice is now implemented below. Further native work should follow a specific unresolved boundary rather than decompiling the entire runtime indiscriminately.

## Continuation: search dispatch and bounded regex Grep

Actual Ghidra completed a nine-entry static pass covering native basename dispatch and selected helper calls. `rg`, `ug`/`ugrep`, and `bfs` reach distinct shims. Parent inspection of original bundled-source spans established that **Grep uses rg**, whereas shell wrappers use ugrep/bfs; these are not interchangeable backends. Findings and exact evidence are in [the Grep contract](grep-contract.md), with native limitations in [the Ghidra report](ghidra-native.md).

Tau's former literal substring Grep is replaced by an independent standalone-rg subset: files/content/matching-line-count modes, regex matching, case/line-number control, mtime/name file ordering and offset/head pagination (250 default, zero removes pagination only). Unsupported options are rejected, not silently stripped. The absolute standalone executable receives config-disabled, bounded UTF-8 contents through stdin and a minimal environment; no original program/module is executed. Workspace/permission gates remain in force. Reads no longer expose the synthetic truncation marker to search.

A proposed simple glob option was removed before completion: independent review reproduced catastrophic backtracking in the existing shared JavaScript glob matcher. Grep now rejects glob requests, including the adversarial pattern. At that point, hardening the standalone Glob matcher remained separate work; it is resolved for tau's subset in the continuation below. The rg engine's guarantees never applied to that JavaScript matcher.

Verification adds mode/default/order/count-vs-occurrence, pagination, invalid regex, missing backend/path, strict-input, binary/prefix, argument-boundary, isolated-environment, output-drain/overflow and cancellation tests. Typecheck and all **76 tests** pass, as do the interactive PTY harness, static target parser and whitespace checks; exact evidence IDs are in the Grep contract. No original runtime or live service comparison is claimed. The bounded-matcher work is completed below; original Read/Edit contracts or structured result serialization remain useful next slices. Keep proprietary recovered bytes and Ghidra projects/tooling output under ignored artifacts.

## Continuation: native terminal-flow annotations and bounded Glob

Actual Ghidra produced a 10/10 baseline and 11/11 treatment. Selecting and marking imported `__exit` thunk `0x106a96fd4` as `noreturn` removed the observed shared-terminal and rg-shim error-path spill into unrelated memory-search code. This is an analyst-annotation experiment, not original ABI recovery. A deeper call reaches `0x1055feddc`, but its sprawling pseudocode follows outside its declared body and is not a complete native behavior specification. See [the native report](ghidra-native.md).

Parent-verified bundled source shows original Glob delegates to `rg --files --null --glob ... --sort=modified`, with hidden/no-ignore enabled by default. Its native grammar, complete ordering behavior and effective configurable limits are not fully established. It uses permission-checked roots rather than tau's independent workspace-only policy.

Tau replaces its vulnerable regex translation with `src/glob.ts`: a finite-state matcher for the existing `*`, `**`, `**/`, `?` subset. It enforces a 1,024-unit pattern limit and a query-wide 10,000,000-cell budget. Exact whole-name and newline matching are explicit; unknown fields, NULs and non-directory roots fail rather than silently producing misleading searches. No native glob parity or Grep glob-filter support is implied.

The isolated old-tau probe timed out at 1.5 seconds despite its 500 ms abort timer. The same rebuilt-tau probe completed normally, with about 2.06 ms measured execution time on this host. This is local comparative evidence, not a portable speed promise. The matcher issue `unk_09d34a1a2d2e9cba` is resolved and its evidence integrity verified.

Typecheck, all **89 tests**, interactive PTY verification and static target parsing pass. Added coverage includes 115,940 deterministic bounded-oracle comparisons, shared-work limits and a child-process hang regression. [The Glob contract](glob-contract.md) records exact original byte spans, algorithm bounds, compatibility gaps and evidence IDs. No original executable/recovered module or live Anthropic request was executed.

## Continuation: native byte I/O and bounded text Read

Actual Ghidra inspected four selected small imported-read callers (**4/4**), then the same callers plus a `___stack_chk_fail` thunk marked `noreturn` (**5/5**). Two `pread$NOCANCEL` callers show byte-count/position loops and numeric-error retries. The other callers include descriptor-0/one-byte and repeated 32-byte reads. The annotation removes a spurious stack-failure continuation; indirect external-target typing remains unresolved. These callers have **not** been connected to application Read. See [the native report](ghidra-native.md). These are derived findings, not runtime observations.

The Read source continuation matched 17 bounded original-executable spans and nine complete module hashes. Verified execution defaults to offset 1 and no line-count limit, not 2,000 lines. JavaScript owns LF-based line windows, CRLF handling, final empty-line counting and decimal-tab numbering. Offset 0 selects the first line with label 0 in ordinary results; empty contents and beyond-EOF windows have separate rendering. This places line semantics in JavaScript without linking any selected native caller to the tool.

Tau now independently supports this bounded regular-text subset in `src/read.ts`, with strict fields, optional offset/limit, numbered lines, distinct empty/EOF results and explicit encoding/media errors. It retains the 64 KiB read-prefix cap rather than scanning the whole file; offsets beyond an incomplete prefix error instead of inventing EOF. Truncated LF/UTF-8 boundaries do not fabricate an unseen empty line or replacement input character. Defaulted options are optional in published input schemas. Unsupported media rendering, contextual large-read overrides, repair/coercion and original token-pagination behavior remain deliberate gaps.

The same independently built probe previously ignored offset 2/limit 1 and returned all fixture lines; it now returns only `2\tsecond`. Final verification passes **101 tests**, typecheck, the interactive PTY harness, static original-target parsing/hash, and tracked/untracked whitespace checks. Tests: `ev_edc3d6305d5cd76e4171ed0ee82907df2cb59ff8da6266ad8e674f6a73419533`; PTY: `ev_39227f41661846b2e12da772a577ed2527ad160892aa7d9d1512eab5ca8809ae`.

A final compiled CLI probe exposed a shared text-output cut inside a UTF-8 code point. Streaming prefix decoding fixes the replacement character and one-byte output-budget overrun without changing the helper's signature or cap. The same loopback-only CLI probe and all 101 tests pass after the fix. Local baseline and treatment artifacts are `artifacts/read-pass/cli-unicode-baseline.json` and `cli-unicode-treatment.json`.

A cross-model review of the decision trail noted that `bounded()` is shared by every tool but had been verified only through Read. A cross-tool regression in `test/contract/tools.test.ts` now checks Grep, Glob and declined Write/Edit approval previews for valid UTF-8, no U+FFFD, the byte cap and the truncation marker. Typecheck and all **102 tests** pass. Tests: `ev_957bc1ea0c5903a9d779a4a866d3685c5839418f385fd047ef21d011249f2ff2`; typecheck: `ev_6d7ccaf1d0427fa19932df4afa502608ce0823cb1880ee873fba85b5c2ae4b6a`; test source: `ev_05277e4c94320a3d5a6ddfd87bedf5082e73de6d4bb5aeea36dd7ce3f9449e17`. Raw Bash capture is unchanged and is not claimed UTF-8-safe.

[The Read contract](read-contract.md) records exact original spans, evidence IDs, interface semantics and limits. Artifacts stay ignored under `artifacts/read-pass/`; the evidence bundle is `artifacts/craft-evidence-read.json`. No original executable/recovered module execution, live Anthropic request, or access to personal Claude settings/credentials/sessions occurred. Next useful slices are source-backed Edit/Write behavior or structured result serialization; original runtime comparisons still require explicit consent.

## Continuation: Edit and Write

A fresh Ghidra pass decompiled selected native write-path callers (8/8, then 9/9 with a `noreturn` treatment). Seventeen bundled Edit and Write source spans were verified byte for byte against the executable. Tau now replaces files atomically through `src/write.ts`, and `src/edit.ts` adds `replace_all`, literal replacement, the original uniqueness rule, newline-on-delete, CRLF round trips and BOM preservation. Write and Edit refuse symlinked final path components; before this slice a symlink inside the workspace was silently followed. Tests came first (15 of 118 failed before), and the final run passes 119 of 119. A compiled-CLI probe confirms the on-disk bytes, file mode and absence of temp files. Read-before-edit staleness, quote folding, UTF-16 and empty-`old_string` creation remain deliberate gaps. See [the Edit and Write contract](edit-write-contract.md) and [the native report](ghidra-native.md#continuation-native-write-path-callers). The evidence bundle is `artifacts/craft-evidence-editwrite.json`.

## Continuation: read state and text fidelity

Resumption found a newer read-state implementation with validation/documentation unfinished. Its eight source spans were reverified; a fresh Ghidra metadata pass completed 4/4, and the inherited 135-test suite plus a cross-turn PTY probe passed. The original guard-skip unknown is now resolved with evidence. Original model/permission-dependent relaxations and mtime shortcuts are documented separately from tau's unconditional complete-Read/content-digest guards in [the read-state contract](read-state-contract.md).

Seven further complete source spans and containing module hashes were verified against the executable. Tau now supports BOM-marked UTF-16LE Read/Edit/Write, UTF-8/UTF-16 BOM and encoding retention, curly-quote matching/style transfer, Unicode-escape spelling conversion and empty-old-string file creation. It also fixes CRLF normalization in LF-majority files and doubled CR in CRLF replacements. [The text-fidelity contract](text-fidelity-contract.md) records exact executable offsets, matching order, backslash rules and deliberate gaps.

All **150 tests**, typecheck and the PTY probe pass. The suite includes a compiled CLI loopback flow that verifies intermediate/final file bytes, file mode and provider-visible events. Test evidence: `ev_72f6f3ce8cbc316d834959cc4f9674c6d29b643be4212e76b3c93225a807de47`; typecheck: `ev_a10348a44cfacc071cee609b482f92519f451aadb8bc067c75eeb5540828ad0c`; PTY: `ev_4394748dffc657c15e68e17b304ea950592a41a2e3b151522b57436757518e57`. No original code, personal account files or live model service was executed/accessed. Analysis artifacts remain ignored.

## Continuation: configured retries and native type refinement

Eleven further executable-verified source spans trace the active coding Messages client into the application retry wrapper. The SDK client explicitly uses zero retries there; the application uses a shared retry ledger and a distinct positive-jitter policy. Tau independently implements bounded pre-stream retries, `--max-retries 0–15` (default 2), retry-header lower bounds, cancellation and no partial-stream replay. [The retry contract](retry-contract.md) distinguishes this subset from the original's auth, billing, watchdog, shared-budget and fallback state. All **161 tests** and typecheck pass, including compiled CLI retry-budget checks. Evidence: `ev_35fb536295502937660099e4ebbdac04982346932069f57e6d86e6b574a6fd06`, `ev_090b73f8fb01444456663f3e87693cf35261e930b1b70d924a5c20ac13b51a7b`.

A fresh Ghidra metadata baseline completed 4/4, followed by a 3/3 syscall-type refinement. Compile-only arm64 SDK layout assertions identify a 144-byte stat structure and the formerly unnamed clamped field as `st_size`. Wrapper conventions and linkage to application tools remain unverified. See [the native refinement](ghidra-native.md#darwin-stat-type-refinement); report evidence `ev_08ee4654b77dfa0a734168de1eca9b587d2d0d1d544d1144acd4290edcde3732`. This pass never executes the target or a generated executable.

## Continuation: attempt admission, body decisions and timing

Thirteen further byte-verified source spans establish that per-model-query retry state is separate from an optional caller-owned API-attempt allowance, and that stream/nonstream paths share that state. Tau now supports `--max-api-attempts`, selected bounded billing/policy error decisions and opted-in one-shot 404 JSON fallback. Compiled CLI fixtures verify streaming → JSON tool response → streaming final response, exhausted allowance with completed tool history, resume and zero admission. A PTY with a two-attempt allowance verifies reset per prompt. See [the attempt-ledger contract](attempt-ledger-contract.md).

All **177 tests** and typecheck pass: `ev_5fa3dd1769d5a6a16e8989877ff75eb1f7c9c8162534157f6034fcd591ee903e`, `ev_217b404ff515de7dc8b34aa47584cfe52584ab1c1fc226c7d09fa7579248be84`. JSON/error body tests cover cancellation, malformed UTF-8/JSON, unsupported/duplicate blocks, byte limits and a stalled body. No original runtime or live API was used.

Actual Ghidra adds a 4/4 native clock baseline and fresh 5/5 typed clock/timebase passes. Compile-only SDK assertions identify CLOCK_MONOTONIC=6 and checked time layouts. A controlled abort-noreturn treatment removes a false initializer continuation; nanosleep's unknown TLS helper paths remain unresolved. Evidence: `ev_0d4cd9720089366fe8beee7aea0e4a003108c68c12096c9cdc5608b1dbc7dd4f`; details in [native clocks](ghidra-native.md#continuation-clocks-and-sleep). No application timer ownership is inferred from those native wrappers.

At this checkpoint, request/first-byte/body-idle semantics remained the next hypothesis. The continuation below verifies it; the earlier trace alone was not treated as a completed specification.

## Continuation: layered deadlines and thread-exit refinement

Thirty bounded original-executable spans across nine hash-checked modules now establish the active timeout layers and setting grammar. SDK fetch timeout ends at headers; an eligible no-response-header watchdog has upload allowance and escalated retry windows; byte-idle and parsed-event progress use separate deadlines; JSON fallback keeps its controller through body consumption. Only thirty consecutive pings renew event progress, including synthetic ten-second heartbeats for newly delivered raw bytes. Dual wall/monotonic clocks support reset coalescing and suspension classification. Evidence: `ev_ecad88181d3d31b9909abd612e2e7e18677fc19d9cefd45cccadf8872355087b`, `ev_8a66d8866f1ee8683609744a633a1899073844833376b12c1fdd7fd265a9169b`.

Tau independently implements this direct-provider subset in `src/timeout-policy.ts` and `src/deadline.ts`, linked into each provider dispatch and body lifetime. Recovered environment settings preserve distinct defaults/floors and boolean/numeric grammar. Header failures consume the existing retry/admission ledger; accepted bodies never replay. All timer scopes dispose on success/failure/cancellation, and final-callback cancellation prevents a JSON success commit. [The timeout contract](timeout-contract.md) records exact source offsets, algorithms and unsupported profiles.

A compiled-CLI local reproduction previously required an external kill after 1.5 seconds when a server withheld headers despite `API_TIMEOUT_MS=75`. It now exits code 1 on its own with a sanitized 75 ms timeout. Nineteen focused clock/HTTP tests cover byte/event reset boundaries, thirty-ping exhaustion and renewal, raw-byte heartbeats, request versus body lifetime, suspension, independent flags, actual connection abort and timer disposal. The expanded suite contains **196 passing tests**; typecheck and the cross-turn PTY pass. Final verification evidence is linked in the current handoff.

Actual Ghidra reuses the existing timing project for two unresolved sleep helpers (**2/2**) and a bounded instruction-flow report (**2 ranges**). One four-instruction helper forwards zero to `pthread_exit`; the SDK-declared noreturn import and derived wrapper annotation remove both its and nanosleep's unrelated continuation (**2/2**). The other helper's indirect/tail paths and application ownership remain unverified. Treatment: `ev_7c94a22194412dfd6af0c3f141c3ffc767c3a41e836badc1f0183e3ed145a58c`; native proof: `ev_02161816cdf6d44510199df3cba9576f0bdfa1574d518e715df38fec27f8de05`. See [the native refinement](ghidra-native.md#continuation-thread-exit-control-flow).

The overall reconstruction remains active. Next useful work is the outer watchdog-error retry/model-fallback state machine and richer event handling, retaining explicit boundaries for unsupported partial-stream recovery. Cloud/gateway routing, live flags and full product parity remain open. No original executable or recovered module was executed, no personal Claude account files were read, and all analysis artifacts remain ignored.

## Continuation: model-query recovery table and TLS terminal chain

Twenty executable-verified source spans establish the full pure recovery decision table, query ledger, five stream progress states, independent special counters, header cap and settings. Tau now independently implements these in `src/recovery.ts` and uses them for request/header/HTTP admission. Ordinary default changes from tau's earlier two to the recovered ten; broad persistent mode defaults300. First-header ordinary retries cap at one independently of ordinary capacity, and suspension uses its own allowance first. See [the recovery contract](recovery-contract.md) for all branches and the precise integration boundary. Source evidence `ev_e351e9150a073910c2e39241c71141d4e5ffe21779efa50850cef910e6f24954`, verification `ev_a975242f1d5d4f2adf426b7ed5906f9f649085b054c25557729f7289407e06e7`.

All **245 tests** and typecheck pass, including real HTTP header-cap/suspension composition, zero-ordinary-budget persistent429 and immediate background529 failure. A historical exhaustion test assumed the old default; it now explicitly requests two retries, while new configuration assertions verify ten. The interrupted old test log is preserved. Existing compiledCLI75ms and cross-turn PTY checks pass. Accepted SSE/JSON recovery is still strict and unreplayed: the new table does not yet alter body/history behavior. Provisional-output rollback, thinking/signature blocks, partial finalization and actual model fallback are next.

Actual Ghidra follows the remaining TLS helper's terminal path through48-byte and60-byte callees (expanded3/3). Bounded instructions establish a straight-line UDF terminal path and a final forwarding call. Guarded noreturn annotations on only those two entries remove the caller's spurious continuation (3/3), preserving its real conditional return and unresolved indirect tail. Treatment `ev_0ec5ac62f0050e9a09d25e7f7d81d665156896576b4118278c362fcc44733ada`; native proof `ev_f4bd0ad77487e5db632e2b94a4c076ad86552abe48ea6c043289594afad18fa5`. No target execution or application ownership inference. Reused project retained; disk now≈5.2GiB free, no unrelated cleanup performed.

## Continuation: accepted-body recovery and provisional output

Thirteen further executable-verified spans establish active reasoning/signature/redacted block parsing, usage-only deltas, coherent-envelope recovery, closed-block partial finalization, enabled-by-default JSON fallback and ordered CLI model fallback. The earlier dT reset guess was corrected: it marks cache state. Tau’s explicit text_reset event is an independent display adapter. Source `ev_68f8c5fc95a506979489c3e5b43319557b6940d995fdc386ce20ce134d95c9ee`, verification `ev_c645a20a50a066f0325e4812e24852a4c499f25036481150e89a5990a147200e`.

The provider now uses one query ledger through accepted SSE/body retries and JSON, preserving shared API admission across ordered model fallback. Fresh parsers prevent mixing partial tool input/signatures between attempts. The agent retains only valid closed blocks, marks incomplete responses, executes closed tools once and preserves reasoning/signatures through sessions. CLI rollback preserves earlier rounds, emits text_reset in structured output and buffers print text until commit. Unicode cell-width handling is pinned to string-width9.0.0, with terminal control sanitization. [The stream contract](stream-recovery-contract.md) records exact behavior, source differences and remaining gaps.

All **266 tests**, typecheck and compiled CLI/session fixtures pass: `ev_2293b6d3212a16aaecda3a192bf83b31a74a9c2e7b9499371eb1274e142d65cd`, `ev_6773363c029ac808f27cb4aec10ef8318654031f1a88cf2cfa435a850bd9a73a`. A12-column realPTY confirms emoji wrapping, one-row rollback, replacement-only saved history, two-attempt admission and clean exit: `ev_f81b165eb3acdb88cf110cf93028d82f17e080239ff50d5b61fa390efe8ad1ef`. A first harness reached the right sequence but failed exit observation; its transcript is preserved, and PTY draining fixes the harness. The existing cross-turn budgetPTY and compiled75ms timeout probe also pass.

Actual Ghidra adds selected recv/recvfrom/poll/connect callers4/4, then4/4 with compile-only checked Darwin import types. The recv wrapper peeks one byte nonblocking and retries EINTR; poll inspects revents; typed stack-failure noreturn removes connect’s adjacent setsockopt spill. No application retry ownership is inferred. Typed evidence `ev_7108c5caa040cab4a62a5e8f59890b9a8d45b52b70b633bf2ddae8f2a20076c5`; SDK check `ev_fcfa77abe1e671661d478d5915871ee8e06de9ee4fc497b32cfc2c8c505471ed`.

At that checkpoint the full reconstruction remained active. The next continuation below resolves selected initial-block/parser and reasoning-request gaps. No original executable/modules, personal Claude account files or live model service were executed/accessed. All recovered artifacts remain ignored.

## Indexed parser and thinking-request continuation

Hypotheses13/14 are supported by26 bounded source spans, complete containing-module hashes and original-file byte comparison: source `ev_460f362ac7ba96319a412fd52b03fa30e7d13cdda144e98de561e3e9c48a00e1`, verification `ev_e69d55b61c9e2c190ec8661b7b5224673b53b9dfeb7ce06c6b3e337376cecd36`. An actual Ghidra read of the imported nonexecutable Bun region independently matches26/26 span hashes (`ev_b37cb778d1230628062ef1a441a249b2da0abb4f4e38b67b3fb6e6ab28e47ea7`). This is a static source-to-image bridge, not JavaScript/native decompilation equivalence. Findings23–25 record the conclusions and validation.

Tau now normalizes start fields, supports sparse/concurrent indexed blocks, replacement of unclosed blocks and closure-order history, follows repeated stop/usage rules and reconciles provisional text. Malformed accumulated tool JSON becomes one bounded error result, allowing model repair next round without replay. BOM/null/primitives, recursive prototype-key stripping and Unicode name/marker bounds follow verified helper behavior. A literal-only AST reader derives24 factual shipped models; independent model/reasoning helpers implement first-party aliases/wire IDs, output defaults and caps, thinking precedence, adaptive selection and budget limits. Full behavior and explicit remaining stricter guards are in [the parser/reasoning contract](parser-reasoning-contract.md).

All **283 tests** and typecheck pass (`ev_d9b237cf5650aefa6b43138291a83bef0a104d26757dcd66141d6b3894aa4bb8`, `ev_2463ed0a179b5ecffd34470df210208f1f1e922d361a7d08cf591603089cc62f`). Real HTTP/agent tests cover malformed-input repair and closure-order reconciliation; HTTP fallback and compiled CLI tests observe thinking/default recomputation, aliases and flag/environment precedence. Fresh genuine-delta PTYs verify staleness/clear/resume and narrow Unicode rollback (`ev_18682ab09523bb3fbf219630b72262ecf4bd5c4785d3b8e1216311daa7641ecd`, `ev_a6d3a7c8ae788f14984ffc8966ba375c38273167b1ec675962a1d6c071ee1837`). First budget fixture recursion failed; the preserved transcript and corrected normalization bypass document the harness fix. The75ms compiled CLI deadline probe passes (`ev_4c468ffb292cfe3eff08c86d9b6c24d0e9b3df0616859129fcf5aaf4acc5106d`).

The full goal remains active. Next trace thinking resumption/signature-prefix and output-filter recovery, contextual fallback lifetime and full provider/auth/capacity routing, then context/product integrations. The shipped catalog is not evidence of service/account availability. No live API or original execution is claimed.

## Thinking continuation, filters and prefix repair

Hypotheses15/16 are supported by33 byte-verified spans across five modules, including complete module hashes and original-file comparisons: source `ev_4bc2b8f0ad497753a2d2b4201fe660afff49ac5b5a75e089bb24fc7dc0c43d16`, verification `ev_d3902c5bd4d1c3b41a3ffde1040899d987ba39e029224af650fbd8ed39ee65f8`. Actual Ghidra independently matches33/33 source spans in imported nonexecutable Bun memory (`ev_e6cf7d03682abe936f460648a3091de1d9eb8f7e780f8e8fe1eca882df87232b`). Findings26–28 record static conclusions, Ghidra scope and runtime validation.

Tau now wires early output-filter retries, DLP precedence, tool-cut closed-block retention, three output-limit continuations and terminal model refusal. Its opt-in thinking path preserves signed chains, recognizes boolean resumability, checks matching models/cache-inclusive context headroom, surfaces prefill refusals to an outer text nudge and disables a rejected beta for the process. Thinking-prefix400 repair maps unique signatures, makes at most two targeted repairs then strips all remaining thinking, and persists its boundaries while retaining original local reasoning. The target count spans stream retries; every dispatch still spends caller API admission. The first implementation review caught an overly broad beta-name match and a repair counter scoped to accepted attempts; qualified-header/marker and cross-stream tests now verify the corrected source behavior.

All **309 tests** and typecheck pass (`ev_03a05b7e972cbd7489472bb81f1398884fbea896ac16874aa7d49be07a5f03a8`, `ev_5fe8436d6204fcc24ccef0bbed96cfb5a29eaf0f99d8adae25e65c3fa3ec6896`). A compiled CLI flow verifies refused beta→nudge→saved reasoning→new-process resume→durable prefix strip, including no local metadata on the wire. Genuine-delta staleness and12-column rollback PTYs pass (`ev_360fc7185e60e193079f8dcb64a3147583ce75eb9e3778031a527d0922fe0086`, `ev_8ba08bae76f77d8ec78019470f56a2f9de09f7ca378ab79aafc5542faf7e61a1`), as does the75ms header timeout (`ev_a9e97477a206e39f602c374272e0838a30a95e3c105cd9d6a896a6fa7193a066`). An old test's expectation that max_tokens forbids even closed calls was removed after source recovery; its initial failure remains in ignored first-tests.txt.

At that thinking-recovery checkpoint the context adapter still defaulted to200k; the next continuation below replaces it. The source's remote feature fallback is false, so experimental resumption remains opt-in. Full reconstruction remains active; no original/module execution, personal account data or live model service was used.

## Context windows and active-context compaction

Hypotheses17/18 are supported by36 bounded source spans across eight complete containing-module hashes and original-file comparisons: source `ev_b3b9081e1bc3201268cfb19fdc6f055fc6aa751dc9d47c57e4c0d76fb0d8f9f9`, verification `ev_03619bd19c53f73106b2599b47240e599073c01cb8fe5ecc89799af9fa6eac88`. Actual Ghidra independently matches36/36 imported nonexecutable Bun spans (`ev_b2a1043844091e0ffd064ffe34c0cfa3de94656f9a512bd6667e43870c26e67b`). Findings29–31 record the static rules, provenance scope and independent runtime results.

Tau now uses model-aware200k/native1M/opt-in windows and selected runtime/client/account overrides; usage includes cache/eligible iterations and server-clearing metadata. Long-context beta refusal is recorded only after a successful resend actually begins a message. Automatic/manual compaction uses recovered threshold/breaker rules and commits a saved active-context boundary while retaining old messages and paired tool tails. Context and prefix repair both honor that boundary. Caller API-budget stops remain distinct from summary failures.

A source review caught an initial mismatch in the summary request: the default cache-prefix fork keeps parent system/tools/thinking and denies execution separately. The implementation and tests were corrected to retain those fields; invalid returned tool calls never execute. The summary instruction is independently authored. The earlier passing331-test run did not prove those request fields matched the target; the corrected fork and budget regressions now bring the suite to333.

All **333 tests** and typecheck pass (`ev_f7d49f85d387429f26fcb92618596bb16a124ca40673821eee3e8a493cd6dea3`, `ev_ac99846ed8e7c5b95d51bbb56ed596d27b820f2a3ba6709716f53117e8046dfa`). Real HTTP tests cover model/window/credit matrices, native1M resumption above200k, usage anchors/iterations, summaries/cancellation/admission, paired tails, breakers and beta proof. A compiled CLI save/resume flow verifies hidden summary output, preserved raw history and boundary/state replay across processes. Actual `/compact` PTY passes (`ev_20339526a6c8ac86e8d091e968f4822648c3da2911a491afc7d6a1f7b5ac1570`), as do existing staleness/Unicode/75ms probes. Artifacts and scripts stay ignored in context-pass.

Read [the context contract](context-contract.md) before continuing. Full reactive/larger-model/precomputed compaction, nuanced tail/fixed-prefix/hooks, served-catalog/account/provider services, request-budget admission and auth/cloud/capacity recovery remain open. Saved raw history still has tau's32MiB cap despite context compaction. No original executable/recovered module, personal Claude state or live model service was executed/accessed.
