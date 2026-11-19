# MCP configuration scopes

The CLI discovers ordinary local MCP configuration before connecting. `mcp-scopes.ts` selects records while retaining origin and transport metadata; `mcp-launch.ts` performs bounded file reads and supplies settings, trust and environment inputs. Runtime connections currently support stdio. HTTP/SSE/WS definitions participate in precedence and policy, then receive an unsupported-transport diagnostic.

## Inputs and precedence

Global configuration normally lives at `~/.claude.json`, or `${CLAUDE_CONFIG_DIR}/.claude.json`. A qualifying legacy `.config.json` inside the configuration directory takes precedence under the recovered metadata checks. Global `mcpServers` supplies user definitions; `projects[canonicalProjectKey].mcpServers` supplies local definitions. They are distinct from `settings.json`.

Project `.mcp.json` files load from eligible ancestors, outermost first. Configured precedence is user, approved project, local, then policy `managedMcpServers`. Repeated explicit `--mcp-config` documents merge afterward. Invalid server entries are skipped individually. A schema-valid record containing an unresolved environment reference remains a candidate with a diagnostic; it must not revive an earlier definition. `${NAME}` and `${NAME:-default}` expansion treats an empty variable as set. Managed policy server records do not use ordinary environment expansion.

Project approval precedes configured merging. A rejected or pending project definition does not shadow a user definition. Configured policy filtering happens after configured merging, so a blocked local definition does suppress a lower user definition. Explicit policy filtering is separate: a blocked explicit override leaves an allowed configured server intact.

`--setting-sources` gates ordinary source discovery. `--strict-mcp-config` suppresses ordinary autodiscovery. The global project record's connection toggles still apply to explicit and enterprise names: ordinary names use `disabledMcpServers`; the pinned `computer-use` name uses `enabledMcpServers` as an opt-in gate. These toggles are independent of project `.mcp.json` approval lists.

## Workspace identity and approval

Global project keys use canonical Git identity when available, including validated linked-worktree metadata. Project settings remain rooted at the startup cwd. Canonical local settings may come from the owned main repository, with legacy cwd local settings merged first. Failed POSIX ownership checks retain the cwd local store without changing the global project identity key.

Persisted trust (`hasTrustDialogAccepted`) is separate from accepted current-session trust. Ordinary print startup accepts session trust without manufacturing a persisted record. Project permission allows require strict persisted trust or a project=user settings-path alias. Local permission grants and local MCP approval use different Git-tracking decisions: indeterminate tracking can admit permission allows while withholding MCP approval. Models and restrictive settings still load from those documents.

Effective project rejection wins first. With strict persisted trust, effective approval lists can admit a server. Otherwise approval considers session choices and eligible settings documents: project documents require the user-path alias, and local documents require their MCP-specific trust decision. Ordinary noninteractive launches can autoapprove pending project servers when the source is enabled. Interactive pending servers can receive once approval; persistence and the full original dialog are not implemented.

## Enterprise presence and server policy

A present `managed-mcp.json` excludes ordinary user/project/local autodiscovery. Valid enterprise definitions override policy-managed names and refuse ordinary explicit configuration or strict mode. A malformed deployed file remains exclusive, dropping ordinary explicit definitions. Host-owned exemptions and held/late-arriving administrator policy are separate workflows.

The filesystem gate starts with `lstat`. Absence and an inaccessible Unix ancestor probe differ from a deployed file whose contents cannot be read. Treating a `realpath` failure alone as deployment caused eight of the first nine isolated scope comparisons to fail; the corrected gate restored the compared outcomes without changing the sandbox profile.

Server denies precede managed allowlist bypass. Ordinary allowlists distinguish names, exact argv and URL rules; typed argv/URL rules suppress name fallback for that transport. Policy-managed definitions ordinarily bypass allowlists; enterprise definitions expanded from environment references do not acquire that bypass. Administrator locks select authoritative allowlists and durable administrator denies remain included. Credential masking, policy-specific environment variants, confined plugin expansion and all host policy channels remain incomplete.

## Verification and boundaries

The corrected nine-case original/Tau matrix matches selected origins, available tool names, calls/errors, per-origin lifecycle, request counts, exit/text and no surviving children: `ev_2fbeeac20d368af72e7cf92ffbe41d9e4a9b6f1384e5b797a4d29eb5a670c720`, `ev_9e9fe86821bcdb5d2125ab69a41ee1b0fefad6683086553f2e612c352e609856`. Each implementation ran nine CLI invocations, eighteen API requests and twenty-five fixture processes. Exact wire/order/result/provider parameters and diagnostic differences remain recorded. One unused workspace-module hash changed during the comparison; the module was not reachable from that checkpoint's CLI import graph. Workspace integration came afterward and has separate compiled nested-Git evidence.

Actual Ghidra matched forty scope spans and the subsequent sixty workspace/skills spans. The recovered integrated baseline passed 621 tests before later workspace/hook/skill changes; consult the current handoff for the newest verification scope. These bounded workflows do not establish full MCP or product equivalence.

Remaining MCP work includes HTTP/SSE/WebSocket and hosted transports, authentication/OAuth, resources/prompts/tasks/elicitation, ToolSearch/deferred loading, plugin/connector/IDE/SDK channels, output schemas/media budgets, complete managed policy, original trust UI/persistence and live reload. Workspace path classification, automount behavior, Windows semantics and source cache invalidation remain partial.
