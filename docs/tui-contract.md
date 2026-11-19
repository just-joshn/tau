# Full-screen terminal contract

Scope: the screens an interactive 2.1.326 session draws, and tau's port of them
in `src/tui/`. Print mode is unchanged. Every quoted bundle literal has a needle
in [tui-needles.json](tui-needles.json) that occurs once in one chunk.

Evidence is the original's own screens. `scripts/differential/run_pty.py` drove
it at 100x30 (`TERM=xterm-256color`) in the verified sandbox. The captures sit
in `artifacts/differential-pass/pty/original-*`. `compare_pty.py` diffs them
with tau's screens step by step. The render snapshot tests replay nine of them
from `test/fixtures/tui/`.

## Terminal mode

The original switches to the alternate screen (`?1049h`), hides the cursor,
turns on bracketed paste and repaints rows in place. On exit it leaves the
alternate screen and prints a dim resume hint on the main screen. Tau does the
same. Each paint is wrapped in synchronized output (`?2026h`/`?2026l`) and
rewrites only the rows that changed. Tau does not turn on mouse tracking.

## Data shape

- `AppState` (`state.ts`) holds the welcome facts, `items: TranscriptItem[]`,
  the editor (`text`, `cursor`), the mode, `busy` (spinner verb and frame), the
  slash suggestions, the armed Ctrl-C or Esc press, history and `view`.
- `TranscriptItem` is a union: `user`, `assistant`, `explore` (counted
  Read/Grep/Glob calls), `tool` (label, target, status, summary, patch),
  `command` (a slash command's echo and result), `notice`, `done`, `interrupted`.
- `View` is the owner of the bottom of the screen: `prompt`, `permission`,
  `help`, `status` or `model`. Each carries the data it shows.
- `update(state, key, now)` (`update.ts`) is the reducer. It returns the next
  state and `Effect`s: `submit`, `interrupt`, `exit`, `mode`, `permission`,
  `model`, `dismiss`. `Tui` (`app.ts`) applies the effects and maps agent
  events onto items.
- `render(state, size)` (`render.ts`) is pure and returns styled rows plus the
  caret. `decodeKeys` (`keys.ts`) turns raw bytes into keys. `paintBytes`
  (`screen.ts`) is the row diff.

## Layout

| Region              | Rule                                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header              | A blank row, three logo rows, a blank row. The logo rows read "<product> v<version>", "<model> · API Usage Billing" and the cwd.                                      |
| Transcript          | Each item is preceded by one blank row. Rows are top-aligned.                                                                                                         |
| Input box           | Pinned to the bottom: a `─` rule, `❯` and a no-break space, the input (hard-wrapped), a rule and one footer row. A blank row always separates it from the transcript. |
| Overflow            | The last `rows` rows show, so the header scrolls off first.                                                                                                           |
| Permission dialog   | Replaces the input box and follows the transcript after a blank row. It is not pinned, so free rows stay blank below it.                                              |
| Help, status, model | A `▔` rule and the pane, pinned to the bottom, at most `rows - 1` rows. A clipped pane ends in `↓`. The transcript's last rows fill the space above it.               |
| Suggestions         | Up to five rows painted over the rows just above the input box.                                                                                                       |

## Footer and modes

shift+tab cycles default → acceptEdits → plan → default (`mode-cycle`). Bypass
joins the cycle after plan only when the launch allowed it. The footer reads
"⏸ manual mode on", "⏵⏵ accept edits on", "⏸ plan mode on" or
"⏵⏵ bypass permissions on" (`mode-manual-indicator`, `mode-accept-indicator`,
`mode-symbols`). A mode other than manual adds "(shift+tab to cycle)". An empty
idle box in manual mode adds "· ? for shortcuts" (`shortcuts-hint`), and a
running turn adds "· esc to interrupt". A first Ctrl-C clears the input and
shows "Press Ctrl-C again to exit" (`exit-hint-key`). A second press within
800 ms exits. Ctrl-D twice on an empty box does the same.

## Transcript rows

| Item          | Rows                                                                                                                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt        | `❯ text` on a grey band the width of the screen                                                                                                                                                     |
| Reply         | `⏺ text`, continuation indented two                                                                                                                                                                 |
| Explore       | `  Searched for N patterns, read N files` (`explore-summary-searches`)                                                                                                                              |
| Tool          | `⏺ Update(a.txt)`. The bullet is grey while pending, green when done and red on error. Then `  ⎿  Added 1 line, removed 1 line` (`patch-added-summary`) and the numbered patch rows, indented five. |
| Refusal       | `  ⎿  Rejected update to a.txt` plus the patch (`patch-rejected-summary`)                                                                                                                           |
| Slash command | `❯ /model` then `  ⎿  Kept model as Sonnet 4.5` (`model-kept`, `model-set`)                                                                                                                         |
| Turn end      | `✻ <verb> for 0s · done 9:15 PM`. The verb is one of eight (`done-verbs`, `done-line`).                                                                                                             |
| Interrupt     | `  ⎿  Interrupted · What should Claude do instead?`                                                                                                                                                 |
| Spinner       | `✽ <verb>…` with one of 187 verbs (`spinner-verbs`), hidden while a dialog is open                                                                                                                  |

A refusal without feedback ends the turn with no interruption row, as in the
capture.

## Dialogs

- **Permission**: a `─` rule, the title ("Edit file", "Bash command", "Tool use"),
  the path, a `╌` rule, the patch, a `╌` rule, the question, the numbered options
  and "Esc to cancel · Tab to amend". Keys: digits pick, arrows move, Enter takes
  the focus, Esc refuses, shift+tab takes the session row, and Tab turns the
  refusal row into a feedback field (`dialog-reject-placeholder`).
- **Confirm** (tau only): approvals the original never asks, such as bypass
  mode, project MCP servers, task stops and subagent plans. They use the same
  frame with "Do you want to proceed?" and Yes or No. They replace the old
  `Allow once? [y/N]`.
- **/help**: tabs General, Commands and Custom commands (`help-tabs`). General
  shows the lead and a three-column shortcut grid. Commands lists "Browse default
  commands:" (`help-commands-title`). ←/→ or Tab switch tabs and Esc closes.
- **/status**: tabs Status and Usage. The fields tau has are Version,
  Session ID, Session kind (`status-session-kind`), cwd, Auth token, API key,
  base URL, Model and Setting sources. Usage shows messages and tokens.
- **/model**: "Select model" (`model-picker-title`), then Default and the four
  family aliases with ✔ on the current one. Enter or a digit picks and Esc keeps.

## Honest differences

- The header names tau and its version. The logo and layout are the original's.
- There is no "· ← for agents" footer hint because tau has no agents panel.
  This costs one row on most screens.
- /help lists only the shortcuts tau implements, so the pane is shorter. "For
  more help" points to `tau --help`.
- /status has no Config or Stats tab and none of the fields tau lacks, such as
  session name, peer address, managed settings or diagnostics.
- /model applies to this session only, so its lead and footer say so. It shows
  no prices and no effort row.
- Suggestions rank by name, then description. The original also weighs usage.
- No onboarding, trust or API-key screens. Tau has no global trust state to set.
- No transcript scrolling, mouse support, queued-prompt display, or replay of
  a resumed session's history.
- Startup diagnostics (settings, skills, agents) show once each as red notices.

## Measured equality

Measured on 2026-11-18 with tau `--unsandboxed` from this checkout. The table
counts rows equal in place after normalization, then rows equal in order (LCS).

| Scenario    | In place        | In order |
| ----------- | --------------- | -------- |
| tour        | 437/540 (80.9%) | 90.4%    |
| edit-always | 264/270 (97.8%) | 97.8%    |
| edit-reject | 207/210 (98.6%) | 98.6%    |

All tour steps except the three panes reach 100% when the agents hint is the
only gap. The panes (help, status, model) score 10%, 0% and 3% in place.

## Root commands

```sh
python3 scripts/differential/run_pty.py tau tour --setup trusted
python3 scripts/differential/run_pty.py tau edit-always --setup trusted
python3 scripts/differential/run_pty.py tau edit-reject --setup trusted
python3 scripts/differential/compare_pty.py tour
python3 scripts/differential/compare_pty.py edit-always
python3 scripts/differential/compare_pty.py edit-reject
python3 scripts/ghidra/needles_to_spans.py docs/tui-needles.json "$TMPDIR/tui-spans.json"
```
