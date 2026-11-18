# Source-derived permission contract

This is a bounded static reading of selected bundled modules from the installed CLI version whose entry source says `2.1.326`. It does not claim complete runtime compatibility. Extracted module code was treated as data and never imported/executed. The independent implementation lives in `src/tool-policy.ts`, `src/tools.ts` and `src/tool-router.ts`. Ordinary MCP integration was added at the492-test checkpoint; this remains a bounded contract, with full managed/identity/classifier policy unfinished.

## Availability is not preapproval

**Derived from source:** launch selection (`Tel`) computes omitted tools and returns `toolsToDisallow`/`toolsKept`. Availability filtering (`qA`) withholds tools outside the session launch list as well as denied tools. An allow rule is not a way to restore tools omitted by the launch selection.

- `chunk-88d8nvn3.js`, `Tel`, executable offset **302636531**, 1777 bytes: `ev_c8705f284912b0fae01451a85fa22e749c5f72ce2c414b65dc7e01280c6d1559`.
- `chunk-s2dj0mp9.js`, `qA`, offset **292101414**, 530 bytes: `ev_fe51dc0fd0a681b7bf6e97fe6c4df9a76baad9b46be686c7972bca54fe6e3cb5`.

The original launch selection also handles tool families/dependencies and presets. Tau's six-tool selection does not implement those expansions. MCP tools are exempt from positive built-in launch selection (`Bgn`), so `--tools ''` leaves discovered MCP tools available; explicit denies still withhold them. This is now implemented through the external router.

## Ordinary deny-before-allow ordering

**Derived from source:** `aEt` invokes early whole-tool denial (`qQn`) and scoped deny matching before tool-specific checks, mode approval, or conditional whole-tool allow lookup. It can also return ask for rules, required interaction, protected/safety objections and policy limits before reaching preapproval. Bypass is therefore not universally “ignore all deny rules.”

- `chunk-4h798pp0.js`, `qQn`, offset **296508795**, 608 bytes: `ev_8f87501505c6db0badb54eb9f6c33dbc1f7ed046571ca04232586b0af83bf8d6`.
- Same module, `aEt`, offset **296516419**, 4297 bytes: `ev_09243ec648fec8a5bf4bb5969ad8e288b517ad94b969d4f666aa21d394f91883`.

This is an ordinary-path description, not an exhaustive total ordering. The source includes classifier, sandbox, MCP, hook and organizational-policy branches that are not reconstructed here. Tau now has the selected ordinary local MCP path below; the other special branches remain unfinished.

## Original rule syntax is richer

**Observed in source:** `Xc` splits list entries on commas and literal spaces outside parentheses, retaining separators inside parentheses. `xr` normalizes tool names through another helper and represents empty/`*` parenthesized content as a whole-tool rule; other content is scoped.

- `chunk-85qjfjsd.js`, `Xc`, offset **281785746**, 359 bytes: `ev_e2f72e7d8376de1754563fcab714214c94192921b663c736bc2df3163bdd32fb`.
- Same module, `xr`, offset **281784859**, 225 bytes: `ev_60cd066a98db4838c174e6530a73505c0420c58939f26f220d05adb1b281995c`.

Tau does not yet implement argument-scoped command/path rules. Built-ins accept case-sensitive exact names `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`. Ordinary MCP rules accept exact qualified names, whole-server `mcp__server`, and `*` in tool suffixes such as `mcp__server__read*`. Matching retains the actual sanitized server-prefix guard; generic cross-server allow wildcards and other pattern grammar remain unsupported. Each CLI list is one quoted argument split on comma/whitespace; original variadic syntax is not supported.

## Plan mode is a known divergence

**Observed:** helper `N8` returns an **ask** result with a plan-mode reason, not a blanket deny. The main evaluator has non-read-only plan predicates and exceptions. A complete original plan-mode reconstruction requires tracing those helpers, tool-specific checks and mode transitions.

- `chunk-4h798pp0.js`, `N8`, offset **294503987**, 133 bytes: `ev_d5dd89d6a6dd9b39f021cc1eaf573cfe6c5e29e96c07058a4415010c18c319f2`.
- Evaluator context: `ev_09243ec648fec8a5bf4bb5969ad8e288b517ad94b969d4f666aa21d394f91883`.

Tau's plan mode **always prohibits Write, Edit and Bash**, even with explicit allow rules. This is a conservative independent policy, not demonstrated original parity.

## Ordinary local MCP policy now implemented

The adapter returns passthrough for ordinary MCP calls. Read-only annotations do not automatically grant permission in default/acceptEdits/plan. In normal plan mode, non-readonly MCP gets an ask before whole-tool allow lookup; readonly can use a matching allow. Bypass allows ordinary calls after earlier gates. `_meta["anthropic/requiresUserInteraction"] === true` asks before both bypass and whole-tool allow. Denial prevents server dispatch.

The50-span consolidated batch includes the adapter, generic evaluator, plan helpers, launch exemption and MCP rule coverage: source `ev_c832d9263aca7248bbe5c2aa98ec5dcea6938d6e89df7963510fc567ad4a1ee8`, Ghidra50/50 `ev_59353583bafae72fda665e732dfdf244f33c6b7002a1665251e3efc832234578`, policy interpretation `ev_db3436615b75ed89a9c3a2e7a816a9df81e63d147b118ed67662378b060a560c`. This ordinary path excludes special connector/design/account-memory, managed/provenance/collision/legacy grant policies, hooks and interactive plan-bypass availability. Full MCP/runtime parity is not established.

## Tau acceptance tests

- `--tools ''` advertises no tools and rejects direct requests for hidden tools.
- `--tools 'Read,Grep'` cannot be expanded by `--allowed-tools 'Write'`.
- Explicit deny defeats allow, default/acceptEdits/plan modes, and bypass.
- Exact-name allow skips the approval prompt for an available tool.
- Plan still denies writes and shell despite exact-name allow.
- Noninteractive Write preapproval succeeds without globally bypassing permissions.
- Hidden/denied tool calls from the local test model cannot change files.
- Unsupported built-in wildcard, command/path and cross-server MCP rules fail before a request is sent.
- MCP positive availability, exact/server/star-suffix matching, ask/plan/required-interaction ordering and denial side effects are exercised in `test/tool-router.test.ts` and the compiled MCP workflow.

See `test/tool-policy.test.ts`, `test/tools.test.ts`, and `test/cli.test.ts`. These tests verify tau's chosen subset, not the original executable's runtime behavior.
