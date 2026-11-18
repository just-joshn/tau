# Turn reminders and request fields contract

Scope: the mid-turn environment update, the task reminder, the date change, `context_management`, and `thinking.display`, in tau's default CLI. Source is the pinned 2.1.326 bundle, read as data. Line numbers refer to `artifacts/claude-restored-2026-11-18/pretty/chunk-4h798pp0.js`. Needles live in `docs/turn-reminders-needles.json`. Each occurs once in one bundle chunk.

## Data shape

| Model                        | tau                                                                       | Source                          |
| ---------------------------- | ------------------------------------------------------------------------- | ------------------------------- |
| What a `cd` can change       | `EnvironmentSnapshot` (`src/environment-reminder.ts`)                     | `_3e`, 3459                     |
| One changed field            | `EnvironmentChange` (workingDirectory with `from`, isWorktree, isGitRepo) | `k3e`, 3471                     |
| Update attachment            | `{type:"environment", snapshot, changes}` in `attachmentSchema`           | `jso`, 135742                   |
| Task nudge attachment        | `{type:"task_reminder", tasks}` in `attachmentSchema`                     | `sAs`, 137627                   |
| Round inputs                 | `RoundFacts` (`src/context-reminders.ts`)                                 | `nRs` producers, 135073         |
| Per-request gating           | `RequestFeatures.plan` → `RequestPlan` (`src/request-features.ts`)        | `fzo`, 114106–114217            |
| Display probe, one per query | `DisplayProbe` = idle → withoutField → spent                              | `tf`, `cUt` 113761, `AG` 113781 |

## Behaviors

Environment update (`$Kt` 3607, `UKt` 3636). Before each later request in a turn, the round compares the shell's cwd and its git facts with the newest `environment` attachment in the active context, or with the turn-start block when there is none. Any difference folds one reminder into the preceding tool result, ahead of the token countdown:

```
<system-reminder>
# Environment update
 - Primary working directory: <now> (was <before>)
</system-reminder>
```

A git change adds ` - Is a git repository: <now> (was <before>)`. Entering a worktree adds the two worktree lines of the environment block. Leaving one adds `The primary working directory is no longer a git worktree.` Paths pass through `mp`: `<` and `>` become named entities, control characters numeric ones. The `cd /` case resets the shell to the start folder, so its result reports `<start> (was <sub>)`.

Task reminder (`rAs` 137614, `T1e` 135045, renderer 203939). The original stores each streamed content block as its own assistant message and skips thinking-only ones. tau counts non-thinking assistant blocks the same way. The reminder fires when both counts reach 10: blocks since the last `TaskCreate` or `TaskUpdate` use, and blocks since the last `task_reminder`. It needs `TaskUpdate` among offered or deferred tools and `CLAUDE_CODE_TODO_REMINDER_MODE` not `off`. Its text ends with a newline, so the wrapped block ends `applicable.\n\n</system-reminder>`. With tasks it adds `\n\nHere are the existing tasks:\n\n#<id>. [<status>] <subject>` lines.

Date change (`f2t` 3953). At a turn start whose local date differs from the date the active context last read, the `date` reminder says `The date has changed. Today's date is now <date>. No need to announce the new date — the user's own clock shows it.` The same date says nothing.

`context_management` (`HMn` 69842, `mV`, beta table `EV`). With enabled or adaptive thinking on a non `claude-3-` model, the body carries `{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}` and the header carries `context-management-2025-06-27`. The beta needs no thinking. `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` turns both off. A 400 that names the beta, says `context_management: Extra inputs are not permitted`, or rejects input tag `clear_thinking_*`/`clear_tool_uses_*` drops the field and beta for that model in the conversation and resends at once. Other betas stay (`Sgt` keeps the rest).

`thinking.display` (`yfi`, `Q7o` in chunk-d73xe1mr; `zqn` 104647). The session display is `omitted` for print `text` and non-verbose `json`. It is `summarized` for interactive sessions with `showThinkingSummaries`, and unset otherwise. A request with thinking on and an interleaved-thinking model carries that display. When the display is unset and neither `showThinkingSummaries` nor `CLAUDE_CODE_THINKING_DISPLAY_UPDATES=false` applies, the request asks for `updates` and adds `thinking-display-updates-2026-08-18`.

Display probe (`cUt`, `AG`). Against an endpoint other than `api.anthropic.com` (`cPt` false), a 400 or 422 that no earlier handler claimed, that is not `billing_error` or a context overflow, and whose request carried a display, resends once without the field. A reply latches the conversation off both the field and the updates beta. A second refusal ends the probe and counts one process-wide failure. After two failures the probe stops. A refusal that names the updates beta drops only that beta.

## Not modeled

- `--thinking-display` and the "withoutUpdates" probe step it enables.
- The `highlights` display for api.anthropic.com first calls.
- The original's other request betas (`claude-code-20250219`, `interleaved-thinking-2025-05-14`, `thinking-token-count-2026-05-13`) and header order.
- Environment changes for additional directories, scratchpad, `gh`, the zsh note, and the agent proxy.
- A task reminder at turn start: tau checks it only before later requests in a turn.
- The assumed-UTC date wording.
