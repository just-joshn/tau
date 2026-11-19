# Interactive terminal contract

Scope: what 2.1.326 shows in an interactive session, what tau shows, and the gaps.
Evidence comes from the recovered bundle (`artifacts/claude-bundle`, read only).
Every quoted literal has a needle in [interactive-needles.json](interactive-needles.json)
that occurs once in one chunk. Live PTY captures of the original now exist.
The full-screen port and its measured equality are in
[tui-contract.md](tui-contract.md).

## Harness

`scripts/differential/run_pty.py` runs either executable under a 100x30 PTY
(`TERM=xterm-256color`). It feeds keystrokes one step at a time and waits for
screen text between steps. `vt.py` is a small screen model. It also answers
cursor-position, device-attribute and colour queries, as a real terminal would.
The Seatbelt profile gains one grant for these runs: read, write and ioctl on the
run's own PTY slave and on `/dev/tty`. Two live canaries guard that grant. The
slave must open inside the profile, and a second, unrelated PTY must not.

Each run writes raw bytes, per-step screens, mock requests and the leftover
config files. The mock keys its replies on markers in the prompt.
`TAU_PTY_TEXT` gets a text reply. `TAU_PTY_EDIT` gets a Read of `a.txt` and then
an Edit of it. Scenarios:

- `tour`: startup, a text prompt, an approved edit, `/help`, `/status`, `/model`, then Ctrl-C twice.
- `edit-always`: option 2, then a second edit that should run without a dialog.
- `edit-reject`: option 3 (No).

## First-run screens (original)

The global config is `$CLAUDE_CONFIG_DIR/.claude.json` (`config-path`). Screens
appear in this order:

1. Onboarding (theme, security notes, terminal setup) runs until `hasCompletedOnboarding` is true (`onboarding-gate`).
2. The trust dialog ("Yes, I trust this folder") shows until `projects[<realpath of cwd or git root>].hasTrustDialogAccepted` is true (`trust-gate`).
3. "Detected a custom API key in your environment" shows until the key's last 20 characters are in `customApiKeyResponses.approved` (`api-key-suffix`). Focus starts on "No (recommended)".

`scenarios_pty.seed` writes one of three setups:

- `fresh`: no config at all.
- `onboarded`: onboarding done and the key approved, so the trust dialog still shows. The scenario accepts it with Enter.
- `trusted`: the onboarded config plus a trusted workspace.

## Tool permission dialog

|                       | Original 2.1.326                                                                                                          | tau                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Header                | "Edit file", "Create file", "Overwrite file" or "Edit notebook", then the path relative to cwd                            | same                                                                                                |
| Body                  | Diff preview                                                                                                              | The same numbered patch, between `╌` rules                                                          |
| Question              | "Do you want to make this edit to **a.txt**?". The verb is "create" or "overwrite" for Write (`question-render`).         | same, without bold                                                                                  |
| Option 1              | "Yes"                                                                                                                     | "Yes"                                                                                               |
| Option 2 (file edits) | "Yes, and switch to **accept edits (auto-approve file edits and common file commands)** for this session **(shift+tab)**" | same text                                                                                           |
| Option 2 effect       | `setMode acceptEdits`, destination `session` (`edit-session-row-update`). Nothing is written to disk.                     | The session mode becomes acceptEdits and the footer reads "⏵⏵ accept edits on (shift+tab to cycle)" |
| When option 2 shows   | Mode is `default` (`session-row-offered-in-default`)                                                                      | Default mode, file inside cwd, path not protected                                                   |
| Last option           | "No"                                                                                                                      | "No"                                                                                                |
| Footer                | "Esc to cancel · Tab to amend"                                                                                            | same                                                                                                |
| Keys                  | Number picks, arrows move, Enter takes the focus, Esc refuses, shift+tab takes the session row, Tab edits the focused row | same, except that Tab always edits the refusal                                                      |
| Other tools           | "Do you want to proceed?" with Yes / don't-ask-again / No                                                                 | "Do you want to proceed?" with Yes / No                                                             |

On refusal the model receives this tool result (`reject-tool-result`):

> The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.

A refusal without feedback also aborts the turn (`reject-aborts-without-feedback`).
Tau records the result, sends no further request, and marks the row
"Rejected update to a.txt" with no interruption row.
With feedback, the text ends "To tell you how to proceed, the user said:\n<feedback>"
and the turn continues. The same holds in tau.

## Slash commands

The original registry holds about 80 built-ins plus bundled skills. Its `/help` is
a tabbed dialog ("general", "commands", "custom-commands"). The registry is
`src/slash-commands.ts`. Tau's `/help` is the same tabbed pane (see
tui-contract.md).

| Command              | Aliases       | Description source                                                           |
| -------------------- | ------------- | ---------------------------------------------------------------------------- |
| /clear               | reset, new    | original                                                                     |
| /compact             |               | original                                                                     |
| /exit                | quit          | original. Prints one of "Goodbye!", "See ya!", "Bye!" or "Catch you later!". |
| /help                |               | original                                                                     |
| /model [model]       |               | original, plus "(currently X)"                                               |
| /permissions [mode]  | allowed-tools | tau. The original manages allow/deny rules. Tau sets the mode.               |
| /resume <session id> | continue      | original. Tau has no picker.                                                 |
| /save                |               | tau only                                                                     |
| /skills              |               | original                                                                     |
| /status              |               | tau. Opens the Settings pane's Status and Usage tabs.                        |

An unknown command prints "Unknown command: /name". The original also suggests
"Did you mean /x?" (`unknown-command`).

## Prompt and exit

The original's first Ctrl-C clears the input and shows "Press Ctrl-C again to
exit" in the footer (`exit-confirm-text`). A second press within 800ms exits
(`double-press-window`). Tau does the same. During a turn, Ctrl-C or Esc
cancels it.

## Gaps

- **Full screen.** Closed by the TUI port. Its remaining gaps are listed in tui-contract.md.
- **Missing standing grants.** There is no directory grant for edits outside cwd, no `.claude` folder session rule, no local-settings rule for generic or MCP tools, and no Bash prefix rule. Each of those cases gets a one-time dialog. The Bash rows belong to the Bash lane.
- **No amend on Yes.** Feedback with "Yes" ("and tell Claude what to do next") is not supported.
- **Tau-only approvals.** Approvals outside the built-in tool gate (bypass confirmation, MCP project servers, background task stop, subagent plan approval, MCP and web tool routers) are Yes/No dialogs in the permission frame.

## Root commands

Run these from the repository root, outside any sandbox. Each one verifies its own isolation first.

```sh
python3 scripts/differential/test_vt.py
python3 scripts/differential/isolation.py verify
python3 scripts/differential/run_pty.py original tour
python3 scripts/differential/run_pty.py original tour --setup fresh
python3 scripts/differential/run_pty.py original edit-always --setup trusted
python3 scripts/differential/run_pty.py original edit-reject --setup trusted
python3 scripts/differential/run_pty.py tau tour
python3 scripts/differential/run_pty.py tau edit-always --setup trusted
python3 scripts/differential/run_pty.py tau edit-reject --setup trusted
```

Artifacts land in `artifacts/differential-pass/pty/`.
