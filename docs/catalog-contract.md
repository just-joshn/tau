# Deferred tool catalog, ToolSearch and NotebookEdit

Source: recovered Claude Code 2.1.326 modules under `artifacts/claude-bundle/`, plus
the original request bodies in `artifacts/workflow-oracles-2026-11-18/original-*-streamjson.json`.

## Data shape

- `CatalogEntry { definition, loading: "eager" | "deferred", searchHint? }`, built by
  `toolCatalog()` in `src/tool-search.ts` from one table, `DEFERRED_BUILTINS`.
- Discovered deferred tools are not separate state. They are the `tool_reference`
  blocks in tool results after the last compaction boundary
  (`discoveredToolNames()`). Saved history carries them across save and resume.
  Compaction drops them, like the original.
- The listing reminder is a `deferred_tools_delta` catalog attachment
  (`addedNames`, `removedNames`) on the user message, next to the agent and skill
  listings, so the listing is announced once per active context.

## Which tools are deferred

- `chunk-qm8c0eq3.js` `T()`/`alt()`: a tool is deferred when it is MCP
  (`isMcp`), unless `alwaysLoad` is set, or when it is a built-in with
  `shouldDefer: true`. ToolSearch itself and StructuredOutput are never deferred (`h()`).
- `shouldDefer` built-ins (searchHint in brackets), found by `shouldDefer:!0`:
  NotebookEdit (`chunk-4h798pp0.js` `jBe`), TaskCreate/Get/List/Update, TaskStop,
  EnterPlanMode (`pT`), ExitPlanMode (`vl`), WebFetch, WebSearch, Cron*,
  EnterWorktree/ExitWorktree, SendMessage, TodoWrite. Tau implements the Task
  tools, TaskStop, the plan tools and NotebookEdit.
- The oracle's first request lists Cron*, EnterWorktree, ExitWorktree, Monitor,
  NotebookEdit, SendMessage, Task*, WebFetch, WebSearch in the reminder.

## Gate

- `chunk-5j9v12kd.js` `tpe()`/`_g()`: tool search is off ("standard") when
  `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` is set or `ENABLE_TOOL_SEARCH` is a
  false value or `auto:N` with N ≥ 100. Otherwise it is on.
- `C()`/`$wn()`: the default unsupported-model list is claude-3-opus, -3-sonnet,
  -3-haiku, -3-5-sonnet, -3-5-haiku and -3-7-sonnet. Tau turns tool search off for them.
- `uMo` "toolSearchToolFilteredOut": a `--tools` list without ToolSearch, or a
  deny rule for it, turns deferral off. Tau checks the same in `cli.ts`.

## Request projection

- `chunk-4h798pp0.js` query builder (`Pi=a.filter(...)`, `deferLoading:$o`):
  a deferred tool is sent only once it is loaded, and then with
  `defer_loading: true` and its full schema. An unloaded deferred tool is omitted.
- `M2n()` inserts `DeferredToolPlaceholder` (`chunk-txkmavag.js` `RLe`/`z9r`,
  `defer_loading: true`, empty object schema) at `length - 1`, before the last tool.
- `WMi` gives the reminder text, a header followed by one name per line, sorted.
  Its header and layout match the oracle. Removals use the "no longer available" text
  and the `D0` ambient line from the `deferred_tools_delta` case.

## ToolSearch

- The description and input schema are copied from the oracle request:
  `ZUo()` = `C + B + F`, `query` string and `max_results` number defaulting to 5.
- Query grammar (`chunk-wxs36rx3.js` `DGs`, `d_`, `T1o`, `Pzt`, `o_`): `select:` is
  case-insensitive and keeps 64 names at most. Names match exactly, then
  case-insensitively. Other queries keep 32 words at most. An exact tool name
  wins. An `mcp__` prefix lists that server's tools. Otherwise `+term` must match
  the name parts, the description or the searchHint, and terms score 10/12 for a
  whole name part, 5/6 for part of one, 10/12 or 3/4 for the coarse name, 3 for
  the full name when nothing else scored, 4 for the searchHint and 2 for a
  description word. Results sort by score and cut to `max_results`.
- Result (`QOo` `mapToolResultToToolResultBlockParam`): matches become
  `[{type:"tool_reference", tool_name}]`. With no match the result is the text
  "No matching deferred tools found".
- Calling a deferred tool before it loads fails with `bmo()`'s
  `InputValidationError: <name> did not run: it was not loaded ...`.

## NotebookEdit (`chunk-4h798pp0.js` `jBe`, `Wun`, `Pkt`)

- Schema `STi`: notebook_path, cell_id?, new_source, cell_type? (code|markdown),
  edit_mode? (replace|insert|delete). Description `$Ao`.
- validateInput order: `.ipynb` extension, `cell_type` needed for insert, a prior
  Read, file freshness, existence, JSON, shape (`t1e`), then cell lookup `Wun`
  (id, then `cell-N`). Tau keeps its stricter digest freshness check
  (`ReadState.assertCurrent`). It needs a complete Read, as Edit does.
- call: replace sets `source` and, for code cells, `execution_count: null` and
  `outputs: []`. A different `cell_type` is applied. Insert creates
  markdown `{cell_type,id,source,metadata}` or code with empty outputs after the
  matched cell, or at index 0. The id is `randomUUID().slice(0,8)` only from
  nbformat 4.5. Delete splices. The file is written as `JSON.stringify(nb, null, 1)`,
  with CRLF kept, encoding and BOM kept, and no trailing newline.
- Result text: `Updated cell <id> with <src>`, `Inserted cell <id> with <src>`
  (or `a new cell`), `Deleted cell <id>`. Hook `tool_response` matches `wTi`.
- Permissions: Edit file rules cover NotebookEdit. `permit()` maps it to the Edit
  operation, so plan mode refuses it and acceptEdits allows it.

## Read of `.ipynb` (`hno`, `o1e`, `gno`, `_Es`, `kEs`, `yno`)

Each cell renders as `<cell id="ID">[<cell_type>T</cell_type>|<language>L</language>]SRC</cell id="ID">`,
where the id defaults to `cell-N`. Code outputs follow: stream text, `text/plain`
results, png/jpeg images and `ename: evalue\ntraceback`. Outputs over 10000
characters become the jq notice. Adjacent text blocks join with `\n`. The result
is a content array.

## Glob and Grep

The original drops Glob and Grep (`JZ()`/`RI()`, `chunk-4h798pp0.js`) only when
its binary embeds bfs/ugrep and aliases `find`/`grep` in Bash
(`EMBEDDED_SEARCH_TOOLS`). That is true for the shipped build on POSIX shells.
Tau's Bash embeds no search binaries, so the gate's premise is false and tau
keeps Glob and Grep.

## Known differences

- The tool order is tau's own and is not alphabetical. ListAgents,
  ReportFindings, ScheduleWakeup and Workflow are eager on the ordinary first
  request. ReportFindings and Workflow sit in the original rare-builtin set
  and defer only when `tengu_shiny_stardust` is on. That flag defaults off,
  and tau keeps both eager. See `docs/eager-catalog-tools.md`.
- "Already available" notes are appended to the ToolSearch result. The original
  sends them as a separate meta user message.
- Not ported: the `auto:N` context threshold (tool search stays on), MCP pending
  server waits, the `<functions>` rewrite for unsupported models (tau turns
  search off for them instead), PreToolUse hooks on ToolSearch, subagent
  catalogs, and the "loaded before summary" re-announcement after compaction.
