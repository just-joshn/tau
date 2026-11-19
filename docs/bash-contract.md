# Bash tool contract (Claude Code 2.1.326 → tau)

Recovered from `artifacts/claude-bundle` (read only, never executed). Each row
names the chunk and the minified function that owns the behavior. The literals
in `docs/bash-needles.json` each occur once, in one chunk.

## Data shapes

| Shape                                                                                                                                                                                                                       | tau                                         | Original                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------- |
| Input `{command, timeout?, description?, run_in_background?, dangerouslyDisableSandbox?}`, strict; `timeout` accepts numeric strings, booleans accept `"true"`/`"false"`, control characters other than tab/newline refused | `src/bash-tool.ts` `parseBashInput`         | 4h798pp0 `Lxi`, `mWo` (`Mj`, `CC`, `pA`)              |
| Prompt facts (gates)                                                                                                                                                                                                        | `src/bash-description.ts` `BashPromptFacts` | 4h798pp0 `bPn`, `kPn`, `M2r`                          |
| Shell session: start folder, current cwd, background registry                                                                                                                                                               | `createShellHost`                           | session `ts(e).cwd`, `Te()`                           |
| Outcome: `completed` · `failed` · `background` · `refused`                                                                                                                                                                  | `BashOutcome`, `renderBashOutcome`          | `mapToolResultToToolResultBlockParam`, `Eq`/`HLr`     |
| Background task `{id, command, description, outputFile, toolUseId, status}`                                                                                                                                                 | `src/background-shells.ts`                  | `Vit`, `HE("local_bash")`, `kc`                       |
| Shell snapshot: absent → `creating` → `ready(file)` \| `failed(reason)`, one per process and shell                                                                                                                          | `src/shell-snapshot.ts` `SnapshotState`     | `Feo` (`y`, `a`), `OZn`, `sM().markSnapshotAvailable` |

## Schema and description

- Schema properties and texts: 4h798pp0 `Lxi`. `run_in_background` is omitted
  when background tasks are disabled (`mWo`, `bXe`). `dangerouslyDisableSandbox`
  is omitted only when unsandboxed commands are disabled (`WRo`); tau has no
  sandbox, so the field is accepted and has no effect.
- `run_in_background` text: zk95hkj7 `U6r`. The long form (default/max) only
  where `__n()` holds, i.e. non-interactive sessions.
- Description: 4h798pp0 `bPn`. Gates and tau's facts:
  - `RI()` embedded find/grep: false in tau (Glob/Grep exist), so the
    IMPORTANT line names `find`/`grep` and adds the Glob/Grep bullets; the two
    `find` bullets drop.
  - `x0n()` `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` (4m8bc75e): cwd sentence.
  - `iKs()` macOS + `/bin/bash` (4hcrrj0t, `UGr` probe): heredoc note, and the
    `git commit -F -` / `--body-file -` examples.
  - `bXe()`/`fTe()`/`Dut()` (2g7yd5jg): background sentence, Monitor and sleep
    bullets. `B6r` adds the deadline sentence only under `__n()`.
  - `akt()` `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS`: the git/PR section (`M2r`).
    Attribution follows the `iPn() === null` branch the oracle shows.
  - `x1()` `CLAUDE_CODE_ENABLE_TASKS=false`: TodoWrite instead of TaskCreate.
- Proof: `test/unit/bash-description.test.ts` renders the original's facts
  byte-equal to `test/fixtures/bash/original-bash-tool.json` (10777 chars).
  `tool-schemas.golden.json` now holds the original's schema.

## Timeouts

- xj0yvmna `Yq`/`zee`: default 120000 (`BASH_DEFAULT_TIMEOUT_MS`), max 600000
  (`BASH_MAX_TIMEOUT_MS`), never below the default; parsed with `hm`.
- zxi: a requested timeout above the max is clamped, not rejected.
- Background: zk95hkj7 `Aje` max 7200000 (raised by a larger foreground max);
  `y_n` default 600000 in single-shot `-p`, 1800000 in other non-interactive
  sessions. Interactive sessions set no deadline unless `timeout` is given
  (inferred from `sBo`/`iqs`; the interactive `Vit` path was not traced).

## Execution

- Shell: 4hcrrj0t `a`/`g`: `CLAUDE_CODE_SHELL`, then `SHELL` (bash/zsh only),
  then zsh/bash by `SHELL` preference across `/bin`, `/usr/bin`,
  `/usr/local/bin`, `/opt/homebrew/bin`. No match throws the original message.
- Command: 4h798pp0 `buildExecCommand`: extglob off (`Tbs`), `unsetenv`
  unalias (`Rbs`), `eval '<cmd>' < /dev/null` (`LZn`/`NZn`; no `/dev/null` with
  a heredoc or `<` redirect), then `pwd -P >| <cwd file>`, joined with `&&`.
  With a usable snapshot the string starts with
  `source <file> 2>/dev/null || true` and spawns as `<shell> -c <string>`;
  without one it spawns `<shell> -c -l <string>` (`getSpawnArgs`). Detached,
  stdout and stderr on one output-file descriptor (`eTs`). Foreground and
  background calls share this path.
- Child env (`c0o`, `G9e`): `SHELL`, `GIT_EDITOR=true`, `CLAUDECODE=1`,
  `CLAUDE_CODE_EXECPATH`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`,
  `CLAUDE_PID`.
- Output file: x2fk4g86 `kc`/`St`:
  `${CLAUDE_CODE_TMPDIR||/tmp}/claude-<uid>/<sanitized start cwd>/<session>/tasks/<id>.output`.
  Ids are `b` + 8 base-36 characters (3v9pk43h `HE`).

## Shell snapshot

Needles: `docs/shell-snapshot-needles.json`.

- When: lazily, on the first Bash call of the process (`v0e` → `Zbs.bash` →
  `gto` caches `shellConfig` per host → `Xbs` → `Feo` → `OZn`). Main session
  and subagents share it. No startup prewarm in 2.1.326. tau keys the cache
  by shell, `HOME` and config folder, and shares it across shell hosts.
- Creation (`OZn`): `<shell> -c -l <script>` via `execFile`, env = process
  env (none under `CLAUDE_CODE_DONT_INHERIT_ENV`) plus `SHELL`,
  `GIT_EDITOR=true`, `CLAUDECODE=1`; timeout `RWe` 10000 ms; maxBuffer 1 MiB.
  File: `<CLAUDE_CONFIG_DIR or ~/.claude>/shell-snapshots/snapshot-<bash|zsh|sh>-<ms>-<6 base36>.sh`
  (`_Jn` adds a session suffix only when `hJn()`, which is false).
- Script (`zws`): `SNAPSHOT_FILE=<Jr(file)>`, then `source "<rc>" < /dev/null`
  when `~/.zshrc` / `~/.bashrc` (`~/.profile` for other shells; `Zvt`) exists,
  then a fresh file with `unalias -a`. With an rc file (`Hws`): bash writes
  `shopt -p`, one `eval %q` line per function not named `_x…` (`PZn` on
  macOS, `$ws` batched read on bash ≥ 5.1 elsewhere, gate
  `tengu_gentle_pumice` default true), `set -o` lines that are on plus
  `monitor`, `shopt -s expand_aliases`, and `\alias -p` as `alias -- …`; zsh
  writes `typeset -f` per `typeset +f` name, `setopt` lines, and `alias` as
  `alias -- …`; at most 1000 aliases. Without one, bash gets only
  `shopt -s expand_aliases`. Then a quoted here-document
  (`CLAUDE_CODE_END_<16>`) with the `pkill` guard (`Iws`) and `export PATH=<the CLI's PATH>` (`Gws`): the
  rc file's PATH changes do not survive on macOS and Linux.
- Result: an `execFile` error (nonzero exit, `exit` in the rc file, timeout)
  or a missing file afterwards → failed; every call then spawns with `-l`.
  Success registers deletion at exit (`kt`). Each call checks the file
  (`Ceo` = `access`); a deleted file falls back to `-l` for that call only.
- `isSnapshotUsable` only decides whether a plugin refresh keeps the snapshot
  (`a0o`). `skipSnapshot` is read by `Feo` but no caller sets it. A diskless
  session (`vA`) never snapshots.

## Working directory

- The cwd file is written only when every step succeeded (`&&`), so a failed
  command keeps the cwd. `_0o`: outside the start folder's tree the cwd returns
  to the start folder and the result gains `Shell cwd was reset to <start>`
  (`g0o`). The failure path drops the note.
- `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR`: every call starts in the start
  folder, no note. Subagents never carry `cd` (`Ht=!Lt`).
- A deleted cwd refuses the call and recovers to the start folder (`v0e`, `TCi`).

## Result text

- Success: `jun` drops blank edge lines; leading blank lines stripped and the
  end trimmed; cwd note on its own line. Empty → `(Bash completed with no
output)` (6dkbe81p `Ie`/`uqs`).
- Failure: `eHt`/`KEi` read the last simple command (grep/rg/egrep/fgrep/find/
  diff/test/`[`, `git diff`/`git grep`: exit 1 is not an error). A failure is
  `Exit code N\n<output>`, trimmed, `is_error: true` (`HLr`, `Eq`); text over
  11024 chars keeps 5000 at each end (`bh`).
- Output over `BASH_MAX_OUTPUT_LENGTH` (default 30000, cap 150000; ytvh0vqm
  `Aj`) is copied to `<config>/projects/<project>/<session>/tool-results/<id>.txt`
  and rendered as `<persisted-output>` with a 2KB preview (6dkbe81p `ofe`,
  `xje`, `rn`).
- Foreground timeout (T8e `#D`): a command whose first word is not `sleep`
  (`Hxi`) moves to the background with `h0o`'s timeout text and the output so
  far; otherwise, or with background disabled, the group gets SIGTERM, then
  SIGKILL after 1.5 s, and the result is `Exit code 143\nCommand timed out
after <bn(ms)>\n<output>`.
- `sleep N` (N ≥ 25) first in a foreground command is refused before running
  (`Uxi`, validateInput) as `<tool_use_error>Blocked: …</tool_use_error>`.

## Background commands

- Launch result: `h0o`. Print mode (`DC()`): "Command running in background
  with ID … You will be notified when it completes. To check interim output,
  use Read on that file path." Interactive adds the do-not-poll variant.
- Exit: `Mke`/`sHt`/`FVn`/`ji`: `<task-notification>` with task-id,
  tool-use-id, output-file, status, summary `Background command "<description
or command>" completed (exit code N)` / `failed with exit code N`, inside the
  `[SYSTEM NOTIFICATION - NOT USER INPUT]` system-reminder (9vn1dyjv `KVt`).
  The output file gains `\n[exited with code N]\n` (x2fk4g86 `lqt`).
- Deadline (`a$o`, `e$o`): notification `status killed`, summary "… was
  stopped after reaching its background time limit" and the `IEa` note; then
  SIGTERM/SIGKILL and `\n[killed]\n`.
- TaskStop (fkkma3m4): `{"message":"Successfully stopped task: <id>
(<command>)","task_id","task_type":"local_bash","command"}`. No notification
  follows a stop (`bV` sets `notified`).
- Reading output: no TaskOutput/BashOutput tool in 2.1.326; the model uses
  Read on the output file (tau admits Read of live task output files).
- `-p` waits for running main-agent background shells and runs a new turn for
  each notification (xt4nsgp1 `park`).

## Remaining differences (tau)

- Shell snapshot gaps: no `rg` alias/function or `find`/`grep` shadows (tau
  embeds no rg, bfs or ugrep; Grep uses rg from PATH), no plugin `bin/` PATH
  entries or plugin-refresh rebuild (`a0o`), no shell-export capture (`jws`,
  bridge sessions only), no spawn-env probe (`DZn`), no Windows PATH probe
  (`Bws`), no cgroup wrapper (`eos`), no debug log or telemetry.
- Lean description variant (`D2r`, `ZI`) and the `F5e` JSON task result are
  not ported; the oracle shows neither.
- Aborting a turn kills the foreground command; the original moves it to the
  background (`backgroundedByTurnAbort`).
- Subagent background shells notify nobody; the original queues to the agent.
- The `-p` background wait has no 600000 ms ceiling
  (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`); background deadlines bound it.
- Not ported: image output (`data:image`), the interactive-prompt stall
  watchdog, the `git … grep` macOS wrapper (`EZn`), `CLAUDE_CODE_SHELL_PREFIX`,
  `CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS`, settings `bashOutputMaxChars` and
  `includeGitInstructions`, the `<persisted-output>` tag neutralizer (`W`).
- The description names the Monitor tool because the original's gate does
  not check for it; tau has no Monitor tool.

## Differential

`scripts/differential/run_bash.py {original,tau}` then `compare_bash.py`
(steps in `scenarios_bash.py`). The comparison normalizes the root, task ids,
session ids and the original's `<total_tokens>` reminder, and accepts the
description difference only as the declared embedded-search gate.

The dummy HOME holds a `.bashrc` with a function and an alias (steps
`greet_fn`, `greet_alias`), so both CLIs build a snapshot from a real rc
file. The profile allows only `SYSTEM_PROGRAMS`, so `awk` and `sed` fail
inside the snapshot script for both.
