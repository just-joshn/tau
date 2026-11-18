# Eager catalog tools

Reference for ListAgents, ReportFindings, ScheduleWakeup and Workflow in Claude Code 2.1.326, and for the tau port.

## Loading

The ordinary first request in `artifacts/workflow-oracles-2026-11-18/original-text-streamjson.json` sends full schemas for these four tools. They are absent from the deferred-tools reminder.

ScheduleWakeup sets `shouldDefer: false` in `chunk-fkkma3m4.js`. ListAgents has a search hint and no `shouldDefer`. ReportFindings and Workflow are the names `dN` and `Wc` in the rare-builtin set `M` in `chunk-qm8c0eq3.js`. `cDa()` defers that set only when `tengu_shiny_stardust` is on. The default is false.

Tau registers all four as eager tools. Their search hints stay on the tool modules for a deferred `select:` lookup. The default catalog does not put the hints on `DEFERRED_BUILTINS`.

## Search hints

- ListAgents. `list agents you can SendMessage to`
- ReportFindings. `report code-review findings as a structured list`
- ScheduleWakeup. `self-pace the dynamic /loop: pick a delay before the next tick, or stop/end/cancel the dynamic loop with stop:true (a fixed-interval /loop is a recurring cron — cancel it with CronDelete)`
- Workflow. `orchestrate subagents with deterministic JavaScript workflow`

## Results

ListAgents returns `No reachable agents.` Peer rows for in-process subagents, teammates, local sessions, cloud sessions and Remote Control are not built.

ReportFindings returns `No findings reported.`, `1 finding reported.`, or `N findings reported.` for a count above one.

ScheduleWakeup clamps a delay into [60, 3600], aligns the fire time with the original minute and cache-lead rules, and uses the original stop, missing-field, plugin-block and aged-out sentences. The book is in memory for the tool instance. Nothing re-enters the session when the time arrives. `noop` is accepted and does not change the result text. The cache anchor is `now`, not a prompt-cache watermark.

Workflow follows the original resolve order. A `scriptPath` is read first. A bare `name` returns `Workflow "<name>" not found. Available: (none)`. An empty input returns `Must provide script, name, or scriptPath`. A missing script file returns `Workflow script file not found: <path>`. A script that passes those checks returns an error result, `Workflow was not launched: this build has no workflow executor.` There is no script VM, no background task, and no resume cache. The permission check asks `Review dynamic workflow before running`.

## Schemas

`test/fixtures/eager-catalog-tools.json` is the first-request tool objects. `test/unit/eager-catalog-tools.test.ts` compares each definition with that fixture.

## Commands

Run these from a checkout that contains `artifacts/claude-bundle`. This worktree does not, because that directory is gitignored.

```
python3 scripts/ghidra/needles_to_spans.py docs/eager-catalog-tools-needles.json "$TMPDIR/eager-spans.json"
python3 scripts/ghidra/span_provenance.py --locate-only "$TMPDIR/eager-spans.json" "$TMPDIR/eager-provenance"
```

Prompt compare, after a tau capture of the same print scenario:

```
python3 scripts/differential/compare_prompt.py artifacts/workflow-oracles-2026-11-18/original-text-streamjson.json <tau-capture.json>
```

The deferred-tools section should still omit these four names. The request `tools` array should include them. CronCreate, CronDelete, CronList and SendMessage remain the other gap.
