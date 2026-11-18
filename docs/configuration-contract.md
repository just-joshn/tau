# Settings, instructions and resume

This checkpoint wires recovered settings and instruction behavior into the compiled CLI. It covers ordinary local direct API-key launches and tau sessions. It does not establish complete original configuration, trust, policy or transcript compatibility.

The pinned target is Claude Code 2.1.326, SHA256 `e214ad76dcc0e846b03be28ed1c2734aacd4e27acb527cb7f8a9e2bed644e837`. Recovered JavaScript is the application evidence. Original observations use dummy settings/credentials, fresh verified disposable isolation, blocked external networking and an exact loopback mock API. Recovered modules are never executed.

## Launch resolution

`configuration.ts` retains documents, diagnostics, effective values, source provenance and permission rules. Ordinary order is user, project, local, flag settings, then managed policy. Objects merge recursively; most arrays accumulate with Set deduplication. `fallbackModel` and `modelPicker` replace their earlier values. Generic JSON validation is explicit: the complete original settings schema is not implemented.

`launch-configuration.ts` selects the user directory from `CLAUDE_CONFIG_DIR` or `~/.claude`, and the platform filesystem managed directory unless `TAU_MANAGED_ROOT` supplies a fixture override. `--setting-sources` gates user/project/local settings and their corresponding instruction sources. Flag and policy inputs remain enabled. `--settings` accepts a file or inline object. Each settings file has a 2 MiB bound.

Fresh workspace permission resolution withholds project allow records, retaining project deny/ask records. Local allow records are admitted in the current ordinary fixture. Full persisted trust, git ownership, tracked local files and canonical local-store roots remain separate work.

`--managed-settings` is a parent launch document. It passes through `managed-parent.ts`, which omits fields such as model, environment and instruction text while conditionally retaining permission grants and restrictive policy fields. Filesystem administrator policy is resolved first. A nonempty authored administrator document wins by default; `parentSettingsBehavior: "merge"` admits the projected parent, merges parent before administrator values, and reapplies the selected parent restriction floors. Higher managed locks can suppress parent grants. An absent administrator document permits the parent. Remote/MDM/helper/held-source admission and tolerant malformed-policy substitutes are not reconstructed by this helper.

Model selection uses explicit CLI selection, nonempty `ANTHROPIC_MODEL`, then settings. Fresh direct API-key launches otherwise use the Opus family override or pinned Opus 5.5. Original account/subscription/host defaults and all managed model access/alias ladders are not inferred from this direct path. The port rejects an empty selected model; that input validation is independent of the source selector's treatment of empty values.

## Permissions at dispatch

Resolved permission rules keep their source alongside CLI policy. Exact built-in allow/deny/ask rules and ordinary MCP rules reach dispatch. Deny wins. Ask requires approval even where the mode would ordinarily permit execution. Source settings Read denies also protect Write/Edit and withhold Project/Local instruction discovery; CLI-only Read narrowing does not acquire that cross-tool effect. Managed/User instructions are distinct from Project/Local discovery.

Ordinary sensitive configuration directories and filenames require a safety approval before whole-tool allows or acceptEdits can authorize mutation. Current-session settings paths are included even if absent or invalid. Ordinary bypass mode can waive this safety hold, while explicit asks remain active. Source-specific launch/worktree exceptions are preserved. This is still a subset of the original host/credential/skill/sandbox permission system; full scoped built-in rule grammar is not accepted as if it were implemented.

## Instruction delivery and Read state

`instructions.ts` discovers managed/user instructions, eligible cwd ancestors, both project instruction locations, local instructions, rules and imports. Raw file admission, model-visible projection and edit baselines are separate. Files are bounded at admission, with canonical identity, exclusions, import depth/cycle handling, conditional rules and explicit external-import approval. The original eager size thresholds are warnings, not unconditional truncation limits.

`instruction-context.ts` announces eager instructions in user context. It records content identity locally so unchanged files are not repeated; fresh-process resume announces changed files and removals. Those local records are stripped from API messages.

Read, including an ordinary filesystem failure after permission/input checks, can activate instructions along the accessed path. Successful local Write/Edit also trigger activation. Nested files appear in tool results and remain separate from the eager catalog. A direct Read of an instruction file does not subsequently cause a duplicate eager announcement. Glob/Grep result names do not automatically activate instructions.

Nested non-Managed files use a model-dependent per-file cap with Unicode-safe and preceding-newline boundaries and an independent continuation notice. Managed files are exempt from this ordinary nested cap. Whole visible unprocessed nested instructions may seed an edit baseline; clipped or processed bodies stay partial. Eager print-mode instructions do not themselves satisfy prior-Read requirements. An already announced full body must not be recapped into a partial view during nested activation.

Remaining instruction work includes complete prior-prefix/alias deduplication, interactive eager seeding, feature-gated eager Project pressure trimming, file watchers, same-process settings reload, Bash/IDE/prompt-mention triggers, diskless/remote exceptions and plugin replacement context. Initial discovery is cached within a context; it is not a general live reload implementation.

## Resume and verification

Tau sessions save their model and base system prompt. A resumed session keeps its saved model unless `--model` is explicit. System snapshots are enabled by default; `--system-prompt-snapshot off` uses the current launch prompt. Fresh processes resolve current permissions/instructions again and discard process-local Read state. This does not implement original transcript migration or every original resume gate.

The compiled `cli-configuration.test.ts` exercises coding, nested activation, changed permissions/instructions on resume, persisted model/system prompts, snapshot-off behavior, and the absence of local metadata on API messages. Other fixtures cover source order, policy composition, Unicode projection, partial read guards and separate eager/nested delivery. The integrated checkpoint passes **561 tests and typecheck**: `ev_aa21b5cb5cb837f99878762a3da9386338fb948b7f5f1d8f5398733886b46b17`, `ev_4ae51381a7664990f630e2df0cd8d41c217aebae8df4d958154a91915677d80f`.

Actual Ghidra matches all **54** selected supplementary instruction/permission/SSE spans: `ev_ff98f549487bb96dd5fac845ed76cbb2b27d3b2d2a43010c43c43330433e6145`. The source reports are `ev_598c9d7dc7041421ceafd52dce3a9508996c8912c0a9ab9fe8092c9b7ce118c9` and `ev_40e6fd673522db050977831eb96b47e2080881bf7b652b73f04afcee8b410645`. Source-byte matching establishes provenance rather than runtime equivalence. The second Ghidra batch matches50/50 parent/default/sensitive spans (`ev_4be12d669bcb7853a7b6a674053cfa37d50b2ebf3bcdd6e66575290c69ef817d`). The corrected21-case isolated settings/resume comparison matches selected request counts, model choice, instruction timing/channels, system versions, tool-error sequences, exit/text and final fixture bytes;42 raw hashes and one consistent port runtime were audited (`ev_450888d78e17e5b3f761769bf54c66478b3290fd3fff2f7f0ed87c7cc2d4a4ef`, `ev_8cc3fbf8e445b32baeefba76bf4c80f54f77429850bc11255f954257c826dda7`). Request parameter differences remain in21cases, schema shapes18 and available tool names4, alongside result/tool-content/stderr framing differences. This is a scoped comparison, not full wire equivalence.

MCP scope autoload and hooks are the next integration workflows. The full product objective also includes plugins/skills/agents/teams/tasks/plans/memory, authentication/cloud providers, original sessions, terminal UI and native distribution behavior. This checkpoint does not complete that objective.
