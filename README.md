# tau

An independent TypeScript coding-agent CLI implementing the core Claude Code-style terminal workflow. **Not a full Claude Code reconstruction, an official Anthropic client, or a drop-in SDK replacement.** It does not wrap or execute the installed `claude` binary. The agent logic and tools are implemented here; model inference uses the Anthropic Messages API.

## Run

Requires Node.js 22+ and an Anthropic API key with access to the selected model. The Grep tool additionally requires a trusted standalone `rg` (ripgrep) in an absolute `PATH` directory; other tools work without it.

```sh
npm ci
npm run build
export ANTHROPIC_API_KEY='your-api-key'
node dist/src/cli.js
```

Or `npm start -- [options]`. To install the local `tau` command, run `npm link` after building. Nothing replaces `~/.local/bin/claude`.

```sh
# Interactive conversation, streaming output, approval before edits/shell
npm start -- "Explain the structure of this project"

# One prompt; file inspection allowed, edits/shell denied without preapproval
node dist/src/cli.js -p "Find the entry point" --permission-mode plan

# Explicitly preapprove file edits, but not shell commands
node dist/src/cli.js -p "Update the README title" --permission-mode acceptEdits

# Piped input and machine-readable results
printf 'Explain the package scripts' | node dist/src/cli.js --output-format json
node dist/src/cli.js -p "List the source files" --output-format stream-json

# Resume tau's own session for the same working directory
node dist/src/cli.js --continue
node dist/src/cli.js --resume SESSION_UUID

# Limit available tools, or explicitly preapprove selected tools
node dist/src/cli.js -p "Summarize this project" --tools 'Read,Glob,Grep'
node dist/src/cli.js -p "Update the title" --allowed-tools 'Read,Edit'
node dist/src/cli.js --disallowed-tools 'Bash'
node dist/src/cli.js -p "Answer without tools" --tools ''

# Configure a local stdio MCP server and preapprove its tools
node dist/src/cli.js -p "Use the project lookup" --mcp-config ./mcp.json --allowedTools 'mcp__lookup__*'

# Select a model available to your account
node dist/src/cli.js --model claude-sonnet-4-5

# Disable ordinary request retries (default: 10; explicit range: 0–15)
node dist/src/cli.js -p "Explain this project" --max-retries 0

# Bound dispatches across all tool rounds and retries for one prompt
node dist/src/cli.js -p "Inspect this project" --max-api-attempts 5

# Disable JSON fallback (enabled by default)
node dist/src/cli.js -p "Explain this project" --no-nonstream-fallback

# Try ordered fallback models when the primary is busy or unavailable
node dist/src/cli.js -p "Explain this project" --fallback-model 'model-b,model-c'
```

Use `--help` for all flags. Model selection uses `--model`, nonempty `ANTHROPIC_MODEL`, then layered settings. A fresh direct API-key launch otherwise uses `ANTHROPIC_DEFAULT_OPUS_MODEL` or the pinned `claude-opus-5-5` default. A resumed session keeps its model unless `--model` is provided.

Thinking is enabled by default on supported models. `--thinking enabled|adaptive|disabled` selects its mode; `MAX_THINKING_TOKENS` supplies a budget when no explicit mode is selected. The deprecated `--max-thinking-tokens N` is available in print mode. Output limits now default per model and recompute on model changes and fallback; `--max-tokens` sets an explicit cap. Pinned catalog aliases and dated first-party IDs are supported. See [the parser and reasoning contract](docs/parser-reasoning-contract.md) for precedence, model capabilities, environment settings and remaining gaps.

Output-limit responses can continue up to three times within the turn and API-attempt bounds. Closed tool calls execute once; unfinished calls are discarded. Early output-filter failures have a separate bounded retry, and recognized thinking-prefix rejections can repair future requests while retaining original local history. Experimental signed-thinking resumption is disabled by default; `TAU_THINKING_RESUMPTION=true` enables the reconstructed first-party path. See [thinking continuation and request repair](docs/thinking-recovery-contract.md) for gates, session behavior and context/profile limitations.

Context capacity now follows the pinned model catalog and selected overrides, including native 1M models and `[1m]` requests. Configured and native windows can compact proactively; default historical windows defer to server admission. A context rejection can trigger a bounded summary and retry, with a one-attempt previous-larger-model fork where eligible. Summaries preserve recent reply groups; size refusals adjust the split, with one eligible deeper reactive pass. `/compact` summarizes the full active conversation and rebuilds file-read state through supported restoration. Old messages remain saved while later model requests start at a summary boundary. `DISABLE_COMPACT` or `DISABLE_AUTO_COMPACT` disables automatic compaction; `CLAUDE_CODE_AUTO_COMPACT_WINDOW` adjusts its window. See [context sizing](docs/context-contract.md), [request admission](docs/request-admission-contract.md), [summary planning](docs/compaction-planning-contract.md), [summary results](docs/summary-response-contract.md), and [fresh summary fallback and remaining gaps](docs/fresh-summary-contract.md).

Pre-stream connection failures and transient HTTP errors retry with bounded exponential backoff, retry-header lower bounds and cancellation. Computed waits over 60 seconds fail. Supported incomplete streams recover according to the source-backed state table, with explicit provisional-text reset; only validated completed blocks can be retained. `--max-turns` counts completed or retained model rounds; request retries and summary attempts share the separate API-attempt allowance. See [the retry contract](docs/retry-contract.md) for behavior and differences from the original.

Ordinary retries now use the recovered default of 10. First-header failures have an independent one-retry cap; suspension has a separate allowance. Environment watchdog settings select persistent/capacity behavior. Accepted-stream recovery, reasoning/signatures, partial finalization and ordered model fallback are now wired; see [the recovery contract](docs/recovery-contract.md).

`--max-api-attempts N` shares a dispatch allowance across a prompt's tool rounds, retries and fallback; zero prevents requests and omission is unlimited. File restoration can make separate auxiliary token-count requests, each with at most one retry; these do not spend the generation allowance. JSON fallback is enabled by default after eligible streaming failures or HTTP 404, subject to that allowance; `--no-nonstream-fallback` disables it. It shares retry capacity but can occur even with ordinary retries disabled. Selected billing/policy refusals stop retries; JSON error metadata inspection is bounded. See [the attempt-ledger contract](docs/attempt-ledger-contract.md).

Requests and accepted bodies have separate deadlines. `API_TIMEOUT_MS` defaults to 600,000 ms through response headers; SSE byte/event watchdogs then detect stalls, while JSON fallback has a full-response deadline. Watchdogs honor the recovered environment settings and dispose timers on success or cancellation. [Stream recovery](docs/stream-recovery-contract.md) describes rollback, reasoning replay and partial-history behavior. See [timeout settings, progress rules and profile differences](docs/timeout-contract.md).

### Interactive commands

`/help`, `/exit`, `/quit`, `/clear`, `/compact`, `/model [ID]`, `/permissions [MODE]`, `/status`, `/save`, `/resume UUID`.

Ctrl-C cancels an active request/tool; Ctrl-C at an idle prompt exits. Tool execution is sequential, so approval prompts do not overlap. Completed tool results are retained after interruption, and unstarted calls receive error results so history remains replayable.

## Tools and permissions

| Tool    | Behavior                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `Read`  | Numbered regular text; whole-file byte/token limits, token-aware pages and streaming explicit line ranges                            |
| `Write` | Creates or replaces a project file; proposed content preview before approval                                                         |
| `Edit`  | Literal/quote/Unicode-escape matching, unique or replace_all replacement; empty old_string creates missing or whitespace-only files  |
| `Glob`  | Bounded state-machine matching of project file paths; `*`, `**`, `?` syntax                                                          |
| `Grep`  | Bounded regex search using standalone rg; files (default), content, or matching-line counts; case/line-number control and pagination |
| `Bash`  | Runs `/bin/sh -c` in the project; bounded output and timeout                                                                         |

| Mode                | Read/search | Write/Edit | Shell |
| ------------------- | ----------- | ---------- | ----- |
| `default`           | Allow       | Ask        | Ask   |
| `acceptEdits`       | Allow       | Allow      | Ask   |
| `plan`              | Allow       | Deny       | Deny  |
| `bypassPermissions` | Allow       | Allow      | Allow |

### Tool selection and explicit rules

`--tools LIST` selects which tools exist for the session: omitted or `default` means all six, `''` means none. `--allowedTools`/`--allowed-tools` preapprove exact tool names. `--disallowedTools`/`--disallowed-tools` deny exact tool names. Availability and deny rules are enforced both in the tool list sent to the model and when dispatching a call—even if the model requests a hidden tool.

Deny and availability restrictions win over explicit allow and bypass mode. Explicit allow does not bypass the built-in plan-mode mutation gate. Allow/deny lists can be repeated and accumulate. Quote each comma/space-separated list as **one argument**, e.g. `--allowed-tools 'Read Edit'`; this implementation does not consume Claude's unquoted variadic syntax. Use `--` before ambiguous prompt text.

Built-in rules accept exact names `Read`, `Write`, `Edit`, `Glob`, `Grep`, and `Bash`. MCP rules accept `mcp__server__tool`, server-wide `mcp__server`, and `*` in the tool suffix, such as `mcp__server__read*`. Command/path rules, cross-server wildcards and other pattern syntax remain unsupported. Tau's blanket built-in plan-write denial is stricter than the original; see [the permission contract](docs/permission-contract.md).

MCP startup loads global user/project-local records, ancestor `.mcp.json` files and managed policy. Global configuration normally uses `~/.claude.json`, or `${CLAUDE_CONFIG_DIR}/.claude.json`; qualifying legacy `.config.json` files take precedence. Ordinary precedence is user, approved project, local, managed, then explicit `--mcp-config` documents. Project approval, source gates and project-local disabled names apply before connecting. `--strict-mcp-config` skips ordinary autodiscovery. A deployed enterprise `managed-mcp.json` is exclusive and can refuse strict or explicit configurations; a failed path lookup alone is not proof of deployment.

`--mcp-config` accepts a JSON file or inline `{"mcpServers":{...}}`; repeat it to merge servers, with later definitions replacing earlier ones. Connections currently support stdio. Each server specifies `command`, optional `args`/`env`, and optional `timeout`/`alwaysLoad`. `${NAME}` and `${NAME:-default}` expand in ordinary command/arguments/environment. Servers run without a shell, inherit the child environment and remain connected across interactive turns. HTTP/SSE/WS definitions participate in scope selection but produce an unsupported-transport diagnostic instead of connecting. Canonical git roots, tracked local approval, credential-aware policy expansion and host/plugin channels remain unfinished; see [MCP scope behavior](docs/mcp-scopes-contract.md).

MCP tools remain available independently of positive built-in `--tools` selection. They ask for permission in default/acceptEdits mode unless preapproved. `readOnlyHint` is metadata, not automatic approval. Plan mutations ask even with an allow rule; plan read-only calls may be preapproved. Required-interaction tools ask even under bypass. Rich results preserve images, structured data, resource links and local metadata through tau save/resume; API requests receive only projected content. Binary results are saved under `.tau/mcp-results` when needed. These are selected ordinary local-server semantics; managed/connector/provenance policies and advanced transports remain gaps.

**Shell commands are not sandboxed.** Once approved, a command can access outside the project, use the network, and inherit environment variables, including API credentials. Use only trusted projects and review commands. `--dangerously-skip-permissions` explicitly selects `bypassPermissions`; it is not needed for normal operation. Print/piped mode cannot ask questions, so approval-required operations are denied.

Filesystem tools check project-root containment and resolved symlinks. They exclude `.git`, `node_modules`, and `.tau`; recursive search skips symlinks. These checks are not an OS-level security boundary against hostile concurrent symlink replacement, hard links, or an approved shell command. They do not identify every possible secret inside your project.

Limits: Read uses262144 whole-file bytes and a default25000-token budget; explicit ranges scan larger regular files with a selected-byte budget of128 times the token limit. Whole reads over tokens return a partial page. `allow_large: true` can lift Read limits using available context shared by that reply's large reads; [large-read admission](docs/large-read-contract.md) explains the rules. Shell/search output stays bounded to64KiB (plus a truncation marker), with5,000 traversal entries,64 traversal levels,1,000 Glob results and a120-second maximum shell timeout (default30 seconds). Write has no artificial1MiB input cap; regular existing-file snapshots have no64KiB cap. Edit rejects metadata sizes above1GiB before reading. Zero-size snapshots that grow while being read have a separate10MiB guard. Saved files are checked against encoded byte size before their read baseline is refreshed. Grep has a 20-second search deadline, retains at most 20,000 rows/about 1 MiB before pagination, and defaults to 250 displayed entries; limit zero removes pagination, not resource limits. Search examines only the read prefix of each file; a missing match does **not** prove absence from a large file. No ignore-file parsing or full ripgrep/glob syntax compatibility is claimed.

Read accepts `file_path`, optional boolean `allow_large`, optional `offset` (default 1; 0 selects the first line with label 0), and optional positive `limit`. There is no 2,000-line default. Explicit ranges can reach later lines. `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` sets a positive token limit. Read output can exceed64KiB; incomplete pages are marked and do not authorize edits. Invalid encoding, decoded NUL, recognized media headers and unsupported fields fail explicitly. See [the Read contract](docs/read-contract.md) for blank lines, EOF, paging, auxiliary counting, and remaining media/context-room gaps.

Existing-file Write/Edit requires a complete, untruncated Read, including in bypass mode. External content changes require rereading; tau changes refresh the baseline. The process-local cache holds 512 paths and resets on clear/resume. After compaction, up to five files are reread in stored modification-time order. Complete restored text establishes a fresh baseline; size-limited references do not. See [file restoration](docs/file-restoration-contract.md). Write/Edit preserve encoding and BOM; empty Write truncates to zero bytes. See [read state and stricter guards](docs/read-state-contract.md) and [encoding, quote/escape matching and creation](docs/text-fidelity-contract.md).

Glob accepts `pattern` and an optional directory `path`; patterns are limited to 1,024 UTF-16 string units and matching shares a 10,000,000-cell work budget across a query. Oversize/over-budget requests fail explicitly instead of blocking on regex backtracking. Other pattern characters are literal, not full native glob syntax; see [the Glob contract](docs/glob-contract.md).

Grep supports `pattern`, `path`, `output_mode`, `-i`, `-n`, `head_limit`, and `offset`. Unknown fields—including glob/type filters, multiline, context and only-matching—are rejected. Config is disabled and only bounded workspace contents are passed to rg through stdin, without a shell or inherited API credentials. See [the Grep contract and deliberate differences](docs/grep-contract.md).

## Configuration and data

- `ANTHROPIC_API_KEY`: required. Never read from or written to `~/.claude/`.
- `ANTHROPIC_MODEL`: default model ID.
- `ANTHROPIC_BASE_URL`: optional trusted Messages-compatible server; `/v1/messages` is appended. Your API key and conversation are sent to this endpoint. HTTP is supported for local development; use HTTPS for remote services. Redirects are refused.
- `API_TIMEOUT_MS`, `CLAUDE_STREAM_IDLE_TIMEOUT_MS`, `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS`, `CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS`: request and stream durations. Body watchdog floors and profile defaults differ; see [the timeout contract](docs/timeout-contract.md). `CLAUDE_ENABLE_BYTE_WATCHDOG` and `CLAUDE_ENABLE_STREAM_WATCHDOG` independently control stream watchdogs.
- `CLAUDE_CODE_MAX_RETRIES`: ordinary retry limit, clamped to 15 unless the broad persistent watchdog is enabled. `CLAUDE_CODE_RETRY_WATCHDOG` enables persistence; scope `CLAUDE_CODE_RETRY_WATCHDOG_SCOPE=capacity` limits it to capacity handling. See [recovery settings](docs/recovery-contract.md).
- `TAU_HOME`: state directory, default `~/.tau`. Sessions are partitioned by canonical project directory, written atomically with mode `0600`; newly created directories use `0700`.
- Settings load from `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`, project `.claude/settings.json`, local `.claude/settings.local.json`, `--settings` (file or inline JSON), then filesystem managed policy. `--setting-sources user,project,local` selects ordinary sources; an empty value disables those three. Permission records retain their source; fresh project allow rules are withheld, while project deny/ask rules remain active.
- `--managed-settings` supplies a projected parent policy. Its model, instructions and environment are omitted. An authored administrator policy takes precedence by default; `parentSettingsBehavior: "merge"` admits the projected parent. Remote/MDM/helper channels and complete managed validation remain unfinished.
- `CLAUDE.md`, `.claude/CLAUDE.md`, local instructions, rules and imports load through the instruction catalog, including managed/user files and eligible project ancestors. Nested instructions activate through Read or successful Write/Edit. External imports require approval. Initial instructions enter user context; nested instructions enter tool results. Processed or clipped instructions do not establish complete edit baselines.
- `TAU_MANAGED_ROOT` overrides the filesystem managed directory for isolated fixtures. Ordinary launch otherwise uses the platform ClaudeCode managed directory.
- `--system-prompt` replaces the built-in system instructions; `--append-system-prompt` appends more. System prompts are saved for resume by default. `--system-prompt-snapshot off` uses the current launch prompt; fresh launches reload settings and instruction files. See [configuration and instruction behavior](docs/configuration-contract.md) for supported paths and gaps.

Session files contain plaintext conversation, reasoning/signatures and tool output. A 32 MiB serialized-size limit prevents overwriting a resumable session with an oversized one. Context compaction retains archived messages, so it does not lower that storage limit. Protect the state directory. Existing directory permissions are not changed. `TAU_HOME` is trusted configuration, not an adversarial path. Do not run concurrent writers against the same session; no locking or merge semantics are implemented. Permissions are chosen afresh on each launch, not restored from a session.

`json` emits one final result. `stream-json` emits `text`, `text_reset`, `usage`, `assistant`, `warning`, `tool_start`, `tool_result`, then `result` JSON lines. A reset replaces only the current model round’s provisional text. Retained incomplete responses carry local partial metadata and a warning; final results mark `is_partial:true`. These are **tau's schemas**, not Claude Code SDK wire compatibility. Results include session ID, concatenated turn text, error status, duration, and cumulative known usage from committed complete or retained partial API responses, including those preceding a turn failure. An interrupted/failed API response may not supply final usage, so this is not a billing ledger. Startup errors go to stderr. Noninteractive turn failures return exit code 1. Tool denial is returned to the model, which can explain it or recover; denial alone does not necessarily fail the turn.

## Implementation

- `src/provider.ts`, `src/retry.ts`, `src/attempt-ledger.ts`, `src/http-error.ts`: bounded retry/admission/error decisions, JSON fallback and SSE/UTF-8 validation.
- `src/timeout-policy.ts`, `src/deadline.ts`: recovered timeout settings, header windows, byte/event progress, dual-clock slack/suspend checks and linked cancellation.
- `src/recovery.ts`, `src/env-settings.ts`: recovered recovery table, query counters/admission, progress classification and shared environment grammar.
- `src/message-stream.ts`, `src/terminal.ts`: reasoning/signature assembly, closed-block retention, provisional text reset and Unicode-aware terminal rollback.
- `src/tool-input.ts`, `src/reasoning.ts`, `src/model-facts.ts`: indexed-input normalization, recoverable tool-JSON errors and model-specific thinking/output requests.
- `src/thinking-history.ts`: signed-chain projection, durable prefix-strip boundaries and output-limit resumption checks.
- `src/output-limit.ts`, `src/context-error.ts`: tentative server output-cap learning and typed context rejections.
- `src/context-window.ts`, `src/context-usage.ts`, `src/compaction.ts`, `src/compaction-plan.ts`, `src/summary-response.ts`, `src/summary-dispatch.ts`: model context selection, usage anchors/iterations, proactive/reactive/manual summaries and saved active-context boundaries.
- `src/agent.ts`: Messages API tool loop, events, replayable interruption handling, turn/token limits.
- `src/agent-definitions.ts`, `src/agent-session.ts`, `src/subagent-runtime.ts`, `src/subagent-lifecycle.ts`: admitted foreground custom agents, isolated child queries, source mode/model rules and scoped lifecycle hooks.
- `src/plugin-catalog.ts`, `src/plugin-components.ts`, `src/plugin-policy.ts`, `src/plugin-launch.ts`, `src/plugin-mcp.ts`: explicit local plugin directories, namespaced commands/skills/agents/hooks, managed/dependency gates and qualified stdio MCP.
- `src/task-store.ts`, `src/task-runtime.ts`, `src/task-session.ts`, `src/plan-runtime.ts`, `src/plan-session.ts`, `src/plan-launch.ts`: local task persistence/lifecycle and main-session plan approval/resume.
- `src/tools.ts`, `src/tool-policy.ts`, `src/tool-router.ts`: filesystem tools, shell process-group cancellation, built-in/external permissions and MCP routing.
- `src/mcp.ts`, `src/mcp-config.ts`, `src/mcp-content.ts`: stdio discovery/negotiation, dynamic tool catalogs, cancellation/deadlines, explicit configuration and rich result projection.
- `src/read.ts`, `src/text-file.ts`, `src/read-state.ts`: bounded decoding, numbered windows, encoding/BOM retention and stale-file guards.
- `src/edit.ts`, `src/write.ts`: quote/escape matching, creation, line-ending preservation and rechecked atomic writes.
- `src/grep.ts`: strict Grep subset, absolute standalone-rg resolution, bounded stdin subprocess and cancellation.
- `src/glob.ts`: bounded, non-backtracking simple-glob state machine and query-wide work budget.
- `src/cli.ts`, `src/options.ts`: terminal interaction and print/structured output.
- `src/configuration.ts`, `src/launch-configuration.ts`, `src/managed-parent.ts`: source-aware settings, launch inputs and parent policy projection/composition.
- `src/instructions.ts`, `src/instruction-context.ts`: instruction discovery, user/tool context announcements and nested Read-state seeding.
- `src/session.ts`, `src/prompt.ts`: persistence and system prompts.
- `src/types.ts`: shared protocol types and schemas (existing scaffolding).

A separate static inspector can reproduce the recovered Bun layout without executing the target:

```sh
node dist/scripts/inspect-bun.js "$HOME/.local/bin/claude"
# Add --modules for the full bounded module metadata list.
```

The inspector distinguishes native `LC_MAIN` from the bundled JavaScript entry, reports preferred virtual addresses, and honors the declared payload length even with section padding. Actual Ghidra headless passes inspected selected native loading, multicall search-helper and byte-I/O functions; see [the native investigation and reproduction steps](docs/ghidra-native.md).

No original executable bytes, bundled application implementation, original system prompt, credentials, or personal session content are incorporated into tau's shipped source. Static analysis recovered bundled JavaScript into the ignored `artifacts/claude-bundle/` directory, separate from the implementation. Do not redistribute these local analysis artifacts as tau code.

## Verification

```sh
npm run check
npm test
```

The suite compiles the project and runs the recorded unit and integration tests (see [current verification status](docs/HANDOFF.md)): real temporary-directory tools, encoding/BOM/quote/escape fidelity, Read windows/byte/token pages/streaming boundaries/shared large-read room and stale-file guards, exhaustive bounded Glob comparisons and an isolated hang regression, regex modes/pagination/ordering and backend isolation, shell output/timeouts/cancellation, fragmented local HTTP SSE, shared API allowances, JSON fallback, billing/body bounds, header/body deadlines, ping limits and clock handling, retry cancellation/non-replay, indexed stream normalization, tool-JSON repair, model-specific thinking requests, output-limit continuation, signed-thinking/prefix recovery, context windows/usage/compaction, output-cap repair, reactive and larger-model admission, agent history, CLI tool use, permission denial, JSON output, session resume, instruction loading, stdio MCP discovery/modern and legacy negotiation, cancellation, dynamic catalogs, rich results and compiled MCP save/resume/permission workflows, source-aware configuration/instruction resolver fixtures, and SSE label/fallback regression cases. No network model calls or live keys are used.

An additional temporary PTY harness checks the interactive prompt, slash commands, mode changes, approval, file writing, cancellation, and clean exit. Live Anthropic service behavior remains unverified. Controlled original-versus-tau print, coding, tool-failure, MCP permission/lifecycle and SSE fallback comparisons now use a verified deny-default disposable macOS sandbox, dummy home/config/credentials and an exact loopback mock endpoint; this does not sandbox tau product tools. See [the subsystem/workflow map](docs/SUBSYSTEM-MAP.md) for verification levels and remaining work, and [the investigation](docs/investigation.md) for earlier evidence.

## Deliberate parity gaps

Remaining work includes subscription/OAuth login, complete original auth/capacity recovery, full account/provider-gated thinking resumption and compaction routing, general media/server-tool blocks, full MCP transport/auth/resources/prompts/task/elicitation support, remaining hook events and attachment semantics, plugins, remaining skill fork/shell/catalog and account-effort workflows, subagents/teams, web tools, browser/IDE integrations, cloud/background sessions, file checkpoint/rewind, sophisticated terminal rendering, streaming JSON input, settings/rule compatibility and original session migration. Tool-rule support covers exact built-ins, scoped local Skill rules and ordinary MCP server/tool-suffix rules; full original grammar and identity/provenance policies remain open. Unsupported stream variants fail explicitly. These features still need source-backed specifications, implementation and verification.

Local skills and command hooks are now integrated into the CLI; see [their contract and remaining gaps](docs/skills-hooks-contract.md). Skills support model invocation and `/NAME args`, with temporary grants/model selection reset at each new query.
