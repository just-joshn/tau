# Monitor, EnterWorktree and ExitWorktree contract

Tau's port of the three deferred tools of Claude Code 2.1.326. Sources are
the recovered bundle chunks named below, read as text. Needles in
`docs/monitor-worktree-needles.json` each occur once in one chunk.
`bun scripts/differential/check_monitor_worktree_bundle.ts <bundle-dir>`
checks them and every schema and description text tau sends.

## Catalog

- All three are `shouldDefer` tools. They reach the model through ToolSearch
  (`src/tool-search.ts` DEFERRED_BUILTINS, with the original search hints)
  and are sent eagerly only when tool search is off.
- Whole-tool rules (`Monitor`, `EnterWorktree`, `ExitWorktree`) work in
  `--tools`, `--allowedTools`, `--disallowedTools` and settings.
- `src/guarded-tool.ts` runs each call in the original order: schema parse
  (`<tool_use_error>InputValidationError: …`), validateInput
  (`<tool_use_error>…</tool_use_error>`), PreToolUse hooks, the tool's own
  check plus rules and mode, then call and PostToolUse. A thrown call error
  is the plain message with `is_error`.

## Monitor (chunk-tzrw0807, chunk-pvr1jj26, chunk-9rq0p1w9)

- Schema `Ee`: `description`, `timeout_ms` (min 1000, max 3600000,
  default 300000), `command`, `ws`; exactly one of command or ws. The object
  is not strict, as in the original.
- Facts fixed for a local session: bounded monitors (`Dye()`, flag default
  true), no Yield tool, no push notifications, not diskless. The deadline cap
  `Pje()` is 10 minutes in a single-shot print session, else 30. Background
  tasks disabled switch the "One" bullet to a foreground Bash loop.
- Permission: `ask` with the command, so print mode needs `--allowedTools
Monitor` or bypass. Command prefix rules (`Monitor(tail:*)`) are not read.
- A monitor is a `local_bash` task in the background-shell registry, id
  `b` + 8 base-36. It runs in the shell cwd; its `cd` never moves the
  session. Stdout is piped and copied to the output file; stderr goes only
  to the output file.
- Lines: trimmed, blanks dropped, 500 chars + `...(truncated)`; a batch
  closes 200 ms after its first line, max 3000 chars + `\n...(truncated)`.
- Rate: bucket of 10, one token per 2 s. Suppressed batches are counted and
  reported as `[N events suppressed — …]` before the next delivered one.
  Suppression lasting over 30 s stops the task with `[Monitor stopped — too
much output (…)]`.
- Event notification: `<task-notification>` with `task-id`, `summary`
  `Monitor event: "<description>"` and `<event>…</event>` (escaped), in
  tau's task-notification system-reminder frame. Events wake the
  end-of-turn wait and are committed before the next model request.
- Exit: one notification with `tool-use-id`, `output-file`, `status`,
  summary `Monitor "d" stream ended`, `… ended without producing output
(exit N)` or `… script failed (exit N)`, and the unflushed lines as an
  `<event>` body.
- Deadline: `[Monitor expired after 5m with N events delivered. Re-arm it if
you still need the watch.]` (or the no-events form naming the output
  file when stderr was written), then a silent stop. TaskStop is silent
  too; lines still buffered at a stop go out as one event.
- Result: `Monitor started (task <id>, expires in <d> unless the source ends
first; you get one notice at expiry — re-arm if you still need the
watch). You will be notified on each event. …`.

## EnterWorktree (chunk-fkkma3m4 Is, chunk-4h798pp0 pVn/EPt/z0o)

- Schema: strict `{name?, path?}`, at most one; name rules from `vts`
  (64 chars, `/` segments of `[A-Za-z0-9._-]`, no `.`/`..`/`.git`).
- Already in a worktree and no `path`: validateInput refusal.
- `name` (or a random `session-<hex>`): `<main repo>/.claude/worktrees/<name
with / as +>`, branch `worktree-<same>`. An existing one is resumed as-is.
  Otherwise `git worktree add --no-track -B <branch> <path> <sha>^{commit}`,
  base `refs/remotes/origin/<default>` (default branch from
  `origin/HEAD`, then `main`/`master`, else `main`), fetched when absent,
  falling back to local HEAD; `worktree.baseRef: "head"` uses HEAD.
  `.claude/settings.local.json` is copied in.
- `path`: must resolve to a registered, non-prunable linked worktree of the
  current repository, not the main tree or the cwd. Under
  `.claude/worktrees/` it is allowed; elsewhere it asks. From inside a
  worktree only managed paths are accepted. Such a worktree is never removed
  by this session.
- The shell cwd and its root (the folder `cd` stays inside and resets to)
  move into the worktree; file tools resolve paths against the root. The
  environment update reminder then reports the new directory and worktree.
- Messages: `Created|Resumed|Entered worktree at “<path>” on branch
“<branch>”. … The session is now working in the worktree. Use
ExitWorktree to leave mid-session, or exit the session to be prompted.`
  Paths and branches use the original `Nv` curly-quote display.

## ExitWorktree (chunk-fkkma3m4 Ns)

- Schema: strict `{action: "keep"|"remove", discard_changes?}`.
- No active session: the `No-op: …` refusal. `remove` of an entered
  worktree: the not-the-owner refusal.
- `remove` without `discard_changes`: refuses with `Worktree has N
uncommitted file(s) and M commit(s) on “<branch>”. Removing will discard
this work permanently. Confirm with the user, …` (status `--porcelain`
  lines, `rev-list --count HEAD ^<base>`), `Could not verify worktree state
…` when git cannot say, or the running-task refusal when a running shell
  task started inside the worktree.
- `keep`: the shell returns to its cwd and root from before the first
  entry; `Exited worktree. Your work is preserved at … Session is now back
in “<cwd>”.`
- `remove`: shell returns first, then `git worktree remove --force` and
  `git branch -D`; `Exited and removed worktree at “…”. Discarded … Session
is now back in …`, or `Exited worktree but could not remove it — kept at
…` when git refuses.

## Known differences

- Monitor `ws` is in the schema and description but refused at
  validateInput; `persistent` (unbounded flag off) is not offered.
- Monitor and Bash permission prefix rules, sandbox network lists, the
  agent-owner checks and the "still running" reminder are absent.
- Worktree hooks (WorktreeCreate/WorktreeRemove), liveness locks,
  `.worktreeinclude` copies, sparse paths, symlinked directories, the
  fresh-base reset of a merged worktree, the stale-origin refetch, tmux
  sessions and the subagent pinned-cwd paths are not ported. Random names
  are `session-<hex>`, not the original word slugs.
- The original's runtime schemas could not be captured; schema texts match
  the bundle, the JSON shape is tau's zod 4 output with the same builders.
- Whether the original's print mode waits for a running monitor before
  exiting is unverified; tau waits like it does for background Bash.
- Differential (`run_monitor_worktree.py`, `compare_monitor_worktree.py`,
  variants `monitor`, `worktree`) is not yet run in the isolation profile,
  which grants no `/bin/sleep` and only the `/usr/bin/git` xcrun shim.
