# System prompt and first-turn reminders

Tau's main-session request carries the pinned 2.1.326 original's default
system prompt and first-turn `<system-reminder>` blocks. Evidence is the
recovered bundle under `artifacts/claude-bundle/` (pretty copies in
`artifacts/claude-restored-2026-11-18/pretty/`) and the print-mode request
oracle `artifacts/workflow-oracles-2026-11-18/original-text-streamjson.json`.
`docs/system-prompt-needles.json` maps 45 ported literals, each occurring once
in one bundle chunk (41 in `chunk-4h798pp0.js`; `identity_agent_sdk` and
`fingerprint_salt` in `chunk-wxeyd558.js`; `billing_header` in
`chunk-d73xe1mr.js`; `agent_claude_when_to_use` in `chunk-cqwkdc0e.js`).

## Data shape

- `src/system-prompt.ts`: `PromptContext` (model, tool names, hasSkills,
  interactive, env) feeds `SYSTEM_PROMPT_SECTIONS`, an ordered list of
  `{ id, render(context) => string | null }`. `renderSystemPrompt` joins the
  non-null sections with a blank line; `--system-prompt` replaces them and
  `--append-system-prompt` follows them. Verbatim text lives in
  `src/system-prompt-text.ts`, generated from the oracle body.
- `systemPromptBlocks` builds the request `system`: billing header (uncached),
  identity line (cached), body (cached). `CompletionRequest.system` is
  `string | SystemTextBlock[]`; subagents and side queries keep strings.
- `src/context-reminders.ts`: `TURN_REMINDERS`, an ordered list of
  `{ id, everyTurn?, render(ReminderContext) }`. `REMINDER_IDS` (in
  `types.ts`) fixes the model-visible order: environment, model,
  deferred_tools, agent_listing, skill_listing, total_tokens, date,
  git_attribution. A row's `reminders` lists the ids of its leading blocks.
  `prependReminders` merges into that run in id order; `projectMessages`
  (`foldRoundReminders`) lifts every leading run in a user round into one
  row ahead of the round, so `mergeUser` adds the original's `\n` seam after
  the last reminder. Tool-result rows still get catalog text appended.
- Seam for the deferred-tool lane: emit a `{ id: "deferred_tools", block }`
  through `prependReminders`; ordering is already reserved.

## Ported behavior and sources

| Behavior | Original (chunk, function) |
| --- | --- |
| Section order, ids, shared/session scope | 4h798pp0 `cds`, `oKo`; joined by `\n\n` in wxeyd558 `J9s` |
| Intro, security and URL lines | 4h798pp0 `Kls`, `HWn`, `zSt` |
| `# System` bullets | 4h798pp0 `Yls`, `BWn("standard")`, `Pls`; bullets `aw` |
| `# Doing tasks` | 4h798pp0 `Xls` (verified-vs-assumed flag off by default) |
| `# Executing actions with care` | 4h798pp0 `Qls` |
| `# Using your tools` (Bash vs PowerShell, TaskCreate/TodoWrite) | 4h798pp0 `Jls` |
| `# Tone and style` | 4h798pp0 `ods` |
| `# Text output` (standard style), pronouns | 4h798pp0 `kls("standard")`, `xls` |
| `# Session-specific guidance` | 4h798pp0 `tds`, `nds`, `eds("with-nudge")`; explore gate `G5` = `!CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS` |
| `# auto memory` (gated; see `docs/auto-memory-contract.md`) | 2e8vamz8 `bQn`, `$o`, `xt` |
| `# Environment` (latest models, surfaces, fast mode) | 4h798pp0 `gds`, `pls`; catalog `latest_per_family` in 9vmv3a50 |
| `# Context management`, act-dont-rederive | 4h798pp0 `_ds`, `ids`, `sds` (`CLAUDE_CODE_ACT_DONT_REDERIVE`) |
| total_tokens line and reminder | 4h798pp0 `YWn`, `Eme`, `vme`, `lVn`; capability `total_tokens_reminder` |
| Identity line | wxeyd558 `zVr` |
| Billing header and entrypoint | d73xe1mr `Ipi`; entrypoint 4k4w82vm `g` |
| Fingerprint `sha256(salt + chars[4,7,20] + version)[:3]` | wxeyd558 `X9s`, `ZCa` (first non-meta user text) |
| Block split and cache marks | wxeyd558 `J9s` (no global-cache path) |
| Environment reminder | 4h798pp0 `FKt`, `vXo`, `hXo`, `wXo`; OS from `os.type()`/`os.release()` |
| Model reminder | 4h798pp0 `IXo`, `DXo`; display names/cutoffs from 9vmv3a50 catalog |
| Date reminder | 4h798pp0 `f2t` |
| Git attribution reminder | 4h798pp0 `y2t`, `p2r`, `m2r`, `$xn` |
| Agent listing text and concurrency note | 4h798pp0 `agent_listing_delta` renderer, `showConcurrencyNote` |
| Skill listing text | 4h798pp0 `skill_listing` renderer |
| Built-in agent `whenToUse` lines | oracle agent listing (cqwkdc0e) |
| Attachments lead the user round | tau's existing RPi note in `projectMessages` |

## Comparator result (text scenario)

`python3 scripts/differential/compare_prompt.py <original> <tau>` against the
oracle and a tau capture of the same flags (json output; tau lacks
stream-json/`--verbose`):

- System: header, identity, intro, System, Doing tasks, Executing actions,
  Tone and style, Text output, Environment and Context management are
  byte-equal after normalization. `test/unit/system-prompt.test.ts` pins their
  SHA-256 so a drift fails locally.
- Reminders: model, agent_listing, total_tokens, date, git_attribution and the
  prompt are equal, in the original's order, with the trailing seam newline.

## Honest differences (tau value kept on purpose)

- `# Using your tools` names `Glob, Grep`: tau ships them as tools; the
  original drops them only when its embedded bfs/ugrep search is present.
- `# Session-specific guidance`: tau has no inherited-context fork subagent,
  so it renders the original's non-fork branch (with-nudge + Explore line).
  `CLAUDE_CODE_FORK_SUBAGENT=0` on the original should match byte for byte.
- `Shell:` in the environment reminder names `/bin/sh`, the shell tau's Bash
  tool spawns (`BASH_SHELL`); the original's Bash uses zsh.
- Skill listing lists tau's discovered skills; the original's bundled skills
  (dataviz, update-config, ...) are not ported.
- Instruction files keep tau's notice format between the reminders and prompt.

## Not ported (remaining work)

- Lean prompt bundle for `lean_prompt` models (Opus 5.5, Sonnet 5.5, Fable,
  Opus 4.8/5, Haiku 5.5): 4h798pp0 `rds` and model-gated sections
  (`_ls` readable variants, `Sls`, `wls`, `Cls`, `$Wn`, `Ils`, `Lls`, `Gls`).
  Tau renders the full prompt for every model; no oracle covers these yet.
- Deferred-tool reminder (owned by the tool-search lane; seam above).
- Request fields: `context_management` `clear_thinking_20251015` (4h798pp0
  `HMn`, beta `context-management-2025-06-27`) and `thinking.display:
  "updates"` (connector-text beta). Both need beta-retry integration in
  `provider.ts`; a first attempt broke the no-beta resend contract and was
  withdrawn.
- Mid-turn total_tokens countdown inside tool results, date-change and
  environment-update deltas, scratchpad and worktree-isolation variants,
  `cch=00000` and other OAuth-only header fields, message-level cache_control.
