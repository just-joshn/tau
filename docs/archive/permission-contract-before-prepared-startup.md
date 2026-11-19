# Source-derived permission contract

This is a bounded static reading of selected bundled modules from the installed CLI version whose entry source says `2.1.326`. It does not claim complete runtime compatibility. Extracted module code was treated as data and never imported/executed. The implementation now composes `tool-policy.ts`, `tools.ts`, `tool-router.ts`, `file-permission-session.ts`, `bash-permission-session.ts` and `scoped-permission-launch.ts`. The Bun checkpoint passes1327tests/119files with typecheck/lint clean. Ordinary scoped file and literal Bash rules are integrated in main/child executors; full managed/identity/classifier/sandbox/remote policy remains unfinished. Source-derived statements and runtime comparison evidence remain distinct.

## Availability is not preapproval

**Derived from source:** launch selection (`Tel`) computes omitted tools and returns `toolsToDisallow`/`toolsKept`. Availability filtering (`qA`) withholds tools outside the session launch list as well as denied tools. An allow rule is not a way to restore tools omitted by the launch selection.

- `chunk-88d8nvn3.js`, `Tel`, executable offset **302636531**, 1777 bytes: `ev_c8705f284912b0fae01451a85fa22e749c5f72ce2c414b65dc7e01280c6d1559`.
- `chunk-s2dj0mp9.js`, `qA`, offset **292101414**, 530 bytes: `ev_fe51dc0fd0a681b7bf6e97fe6c4df9a76baad9b46be686c7972bca54fe6e3cb5`.

The original launch selection also handles tool families/dependencies and presets. Tau composes builtin, Skill, Agent, Task, Plan and external catalogs, but does not implement every native dependency/preset expansion. MCP tools are exempt from positive built-in launch selection (`Bgn`), so `--tools ''` leaves discovered MCP tools available; explicit denies still withhold them. This is now implemented through the external router.

## Ordinary deny-before-allow ordering

**Derived from source:** `aEt` invokes early whole-tool denial (`qQn`) and scoped deny matching before tool-specific checks, mode approval, or conditional whole-tool allow lookup. It can also return ask for rules, required interaction, protected/safety objections and policy limits before reaching preapproval. Bypass is therefore not universally “ignore all deny rules.”

- `chunk-4h798pp0.js`, `qQn`, offset **296508795**, 608 bytes: `ev_8f87501505c6db0badb54eb9f6c33dbc1f7ed046571ca04232586b0af83bf8d6`.
- Same module, `aEt`, offset **296516419**, 4297 bytes: `ev_09243ec648fec8a5bf4bb5969ad8e288b517ad94b969d4f666aa21d394f91883`.

This is an ordinary-path description, not an exhaustive total ordering. The source includes classifier, sandbox, MCP, hook and organizational-policy branches that are not reconstructed here. Tau now has the selected ordinary local MCP path below; the other special branches remain unfinished.

## Original rule syntax is richer

**Observed in source:** `Xc` splits list entries on commas and literal spaces outside parentheses, retaining separators inside parentheses. `xr` normalizes tool names through another helper and represents empty/`*` parenthesized content as a whole-tool rule; other content is scoped. Its caller Ng changes the allow direction for a finite compatibility set under a default-enabled feature, as described below; xr alone is not the final behavior-aware rule contract.

- `chunk-85qjfjsd.js`, `Xc`, offset **281785746**, 359 bytes: `ev_e2f72e7d8376de1754563fcab714214c94192921b663c736bc2df3163bdd32fb`.
- Same module, `xr`, offset **281784859**, 225 bytes: `ev_60cd066a98db4838c174e6530a73505c0420c58939f26f220d05adb1b281995c`.

Tau now accepts quoted Read(path), Edit(path), Write(path) and Bash(command) rule spellings in permission lists. Availability still selects tool names, rather than scoped rules. Ordinary MCP rules accept exact qualified names, whole-server `mcp__server`, and `*` in tool suffixes such as `mcp__server__read*`. Matching retains the actual sanitized server-prefix guard; cross-server allow wildcards remain unsupported. Each CLI list is one quoted argument split on comma/whitespace; original variadic syntax is not implemented.

### Behavior-aware wildcard compatibility

Native Ng/joi applies the default-true fYr compatibility override only to Read, Edit, Write, NotebookEdit, Glob, Grep, LSP and SendUserFile. Allow `Tool()`/`Tool(*)` for those names retains content `*`; it is not an unrestricted bare-tool allowance. Actual file compatibility consumption requires the exact actual tool name and working-directory stage. Deny/ask uses xr's bare normalization. Bash is absent from this finite set, so `Bash()`/`Bash(*)` normalizes to ordinary bare Bash. Raw escaped/padded star content does not silently receive this special classification. Native whole-tool allowances still follow their own admission and safety stages.

The port preserves this distinction for supported rules. Its Read/Write/Edit compatibility grants require requested and canonical paths inside cwd, after earlier holds. Generic settings Glob/Grep compatibility grants remain withheld pending their dedicated consumers; readonly defaults remain separate. Dedicated Bash preparation is required for actual content rules, not empty/star spellings alone. Source/Ghidra: `artifacts/native-bash-command-preparation-research/COMPATIBILITY.md`, `artifacts/bash-compatibility-ghidra/REPORT.md` (31unique spans,15new/16prior).

### File and literal command consumers

Read(path) selects the Read family. Scoped Edit(path) selects the shared Write/Edit file-content family; bare Edit is not a Write alias, and Write(path) does not become Edit(path). Live source/mode admission retains user/project/local/flag/policy/CLI provenance, source-root anchoring, native ignore matching, POSIX spelling/twin identity and fixed/relative ordering. Source-root slash syntax differs from relative cwd patterns; a slash rule in user settings is rooted at the user config context rather than assumed cwd.

The actual tool stage retains availability, generic primitive deny/ask, scoped deny/ask, effective post-hook replacement validation, sensitive identities, Plan floor, memory stage, complete Read baselines, final path/race checks and approval. Scoped Read also applies to post-compaction rereads. Shared owning physical history does not merge child policy grants. Missing native consumers reject rather than ignore scoped rules.

The Bash adapter evaluates exact and prefix stages for known simple literal POSIX commands. Exact restrictive candidates and prefix restrictions precede grant use. Shell AST, wrapper/env preparation, redirections, expansions, native sandbox and broader security branches remain incomplete; scoped unknown forms explicitly hold. Bare Bash uses the port's existing execution path and is not evidence of native sandbox parity. Root transitions/worktrees/additional directories and nonordinary host profiles require explicit adapters.

Evidence and limits: `artifacts/scoped-permission-integration/REPORT.md`, selected source/Ghidra contracts in `artifacts/origin-permission-sessions-ghidra/REPORT.md` and `artifacts/file-permission-compat-ghidra/REPORT.md`. Ten authored integration tests include an11-request real Bun main/child/hook-rewrite workflow. Two bounded original/copiedBun FILE/BASH controls now match28selectedfields/11audits across22Messages4CLI, with exact matched port source/dependency snapshots and clean isolation. See artifacts/differential-pass/scoped-permissions-tau-before/comparison.json. This verifies only the recorded ordinary file and fixed literal printf cases, not full shell or wire equivalence.

## Plan mode is a known divergence

**Observed:** helper `N8` returns an **ask** result with a plan-mode reason, not a blanket deny. The main evaluator has non-read-only plan predicates and exceptions. A complete original plan-mode reconstruction requires tracing those helpers, tool-specific checks and mode transitions.

- `chunk-4h798pp0.js`, `N8`, offset **294503987**, 133 bytes: `ev_d5dd89d6a6dd9b39f021cc1eaf573cfe6c5e29e96c07058a4415010c18c319f2`.
- Evaluator context: `ev_09243ec648fec8a5bf4bb5969ad8e288b517ad94b969d4f666aa21d394f91883`.

Tau supports source-backed designated plan-file writes, main/child plan storage and an approval-driven exit workflow. Ordinary non-plan Write/Edit/Bash operations still meet the conservative read-only floor even with scoped grants. Ordinary memory writes in inherited Plan children remain unresolved: original C and C2 stopped before child execution at an upstream AUTO gate, so they provide no child file-permission conclusion. The separate ordinary main Plan controls have selected original comparisons; they do not prove every Plan exception.

## Ordinary local MCP policy now implemented

The adapter returns passthrough for ordinary MCP calls. Read-only annotations do not automatically grant permission in default/acceptEdits/plan. In normal plan mode, non-readonly MCP gets an ask before whole-tool allow lookup; readonly can use a matching allow. Bypass allows ordinary calls after earlier gates. `_meta["anthropic/requiresUserInteraction"] === true` asks before both bypass and whole-tool allow. Denial prevents server dispatch.

The50-span consolidated batch includes the adapter, generic evaluator, plan helpers, launch exemption and MCP rule coverage: source `ev_c832d9263aca7248bbe5c2aa98ec5dcea6938d6e89df7963510fc567ad4a1ee8`, Ghidra50/50 `ev_59353583bafae72fda665e732dfdf244f33c6b7002a1665251e3efc832234578`, policy interpretation `ev_db3436615b75ed89a9c3a2e7a816a9df81e63d147b118ed67662378b060a560c`. This ordinary path excludes special connector/design/account-memory, managed/provenance/collision/legacy grant policies, hooks and interactive plan-bypass availability. Full MCP/runtime parity is not established.

## Tau acceptance tests

- `--tools ''` advertises no tools and rejects direct requests for hidden tools.
- `--tools 'Read,Grep'` cannot be expanded by `--allowed-tools 'Write'`.
- Explicit deny defeats allow, default/acceptEdits/plan modes, and bypass.
- Exact-name allow skips the approval prompt for an available tool.
- Plan retains ordinary mutation/shell holds while its designated plan-file and exit approval workflow have separate gates.
- Noninteractive Write preapproval succeeds without globally bypassing permissions.
- Hidden/denied tool calls from the local test model cannot change files.
- Scoped file/literal Bash rules are consumed by dedicated hosts; availability call forms and unsupported cross-server MCP grammar reject. Unknown shell/root/host profiles explicitly hold rather than become broad grants.
- Scoped Edit(path) permits only selected Write/Edit operations; bare Edit and Write(path) do not grant Write through that shared family.
- Native finite-set wildcard classification, source roots, inherited Read restrictions, hook-rewritten paths and compaction rereads retain their separate stages.
- MCP positive availability, exact/server/star-suffix matching, ask/plan/required-interaction ordering and denial side effects are exercised in `test/tool-router.test.ts` and the compiled MCP workflow.

See `test/tool-policy.test.ts`, `test/tools.test.ts`, `test/scoped-permission-launch.test.ts`, `test/cli-scoped-permissions.test.ts` and the linked session/host tests. These tests verify tau's chosen subset, not the original executable's runtime behavior.
