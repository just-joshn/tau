/**
 * The Bash tool's shell snapshot (chunk-4h798pp0 OZn, zws, Hws, Gws, Iws,
 * Feo). The first Bash call of a process runs the user's rc file in a login
 * shell and writes its functions, options and aliases to
 * `<config>/shell-snapshots/snapshot-<shell>-<ms>-<rand>.sh`. Every command
 * then sources that file and spawns without `-l`. A snapshot that failed, or
 * whose file is gone, falls back to `-l` for that call.
 */
import { execFile } from "node:child_process";
import { unlinkSync } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** RWe: the snapshot shell's time limit. */
export const SNAPSHOT_TIMEOUT_MS = 10_000;

export type SettledSnapshot =
  { kind: "ready"; file: string } | { kind: "failed"; reason: string };
/** Absent until the first call asks; one per shell, home and config folder. */
export type SnapshotState =
  { kind: "creating"; settled: Promise<SettledSnapshot> } | SettledSnapshot;

/** Jr(): bare when every character is safe, otherwise single-quoted. */
export function shellQuote(text: string): string {
  if (text === "") return "''";
  if (/^[A-Za-z0-9_./:=@+,-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

const shellKind = (shell: string) =>
  shell.includes("zsh") ? "zsh" : shell.includes("bash") ? "bash" : "sh";

/** Zvt(): the rc file the snapshot sources. */
function rcFile(shell: string, home: string): string {
  const name = shell.includes("zsh")
    ? ".zshrc"
    : shell.includes("bash")
      ? ".bashrc"
      : ".profile";
  return path.join(home, name);
}

const BASH_FUNCTIONS = `declare -F | while read func; do
        func=\${func##* } # the name: the last word of each declare -F line
        # declare reads a name starting with - or + as an option, and eval one starting with -; other names need no "--"
        if [[ "$func" == [-+]* ]]; then
          printf 'eval -- %q > /dev/null 2>&1\\n' "$(declare -f -- "$func")" >> "$SNAPSHOT_FILE"
        else
          [[ "$func" == _[!_]* ]] ||
            printf 'eval %q > /dev/null 2>&1\\n' "$(declare -f "$func")" >> "$SNAPSHOT_FILE"
        fi
      done`;
/** $ws: one read of every function on bash 5.1+, the loop otherwise (not on macOS). */
const BASH_FUNCTIONS_BATCHED = `declare -F | (
        trap - DEBUG
        ((BASH_VERSINFO[0] * 100 + BASH_VERSINFO[1] >= 501)) &&
        __cc_all=$(
          __cc_count=0
          while [[ "$__cc_count" != none ]] && builtin read func; do
            func=\${func##* }
            if [[ -z "$func" || "$func" == [-+]* ]]; then
              __cc_count=none
            elif [[ "$func" != _[!_]* ]]; then
              declare -f "$func"
              builtin printf '\\037'
              __cc_count=$((__cc_count + 1))
            fi
          done
          builtin printf %s "$__cc_count"
        ) &&
        set -f &&
        IFS=$'\\037' &&
        set -- $__cc_all &&
        [[ "\${!#}" == "$(($# - 1))" ]] &&
        set -- "\${@:1:$# - 1}" &&
        (($#)) &&
        printf 'eval %q > /dev/null 2>&1\\n' "\${@%$'\\n'}" >> "$SNAPSHOT_FILE"
      ) || ${BASH_FUNCTIONS}`;

/** Hws(): functions, options and aliases the rc file left behind. */
function userConfigCapture(rc: string, platform: NodeJS.Platform): string {
  const zsh = rc.endsWith(".zshrc");
  let script = zsh
    ? `
      echo "# Functions" >> "$SNAPSHOT_FILE"

      # Force autoload all functions first
      typeset -f > /dev/null 2>&1

      # Now get user function names - filter completion functions (single underscore prefix)
      # but keep double-underscore helpers (e.g. __zsh_like_cd from mise, __pyenv_init)
      typeset +f | grep -vE '^_[^_]' | while read func; do
        typeset -f "$func" >> "$SNAPSHOT_FILE"
      done
    `
    : `
      # shopt before functions: a body using extglob/globstar syntax only
      # re-parses with the option on.
      echo "# Shopt" >> "$SNAPSHOT_FILE"
      shopt -p >> "$SNAPSHOT_FILE"

      echo "# Functions" >> "$SNAPSHOT_FILE"

      # Force autoload all functions first
      declare -f > /dev/null 2>&1

      # Now get user function names - filter completion functions (single underscore prefix)
      # but keep double-underscore helpers (e.g. __zsh_like_cd from mise, __pyenv_init)
      # One eval per function so a body that no longer parses (rc=2, not fatal
      # in non-POSIX bash) drops only itself. The %q literal needs no fork
      # at source time, unlike a base64 command substitution.
      ${platform === "darwin" ? BASH_FUNCTIONS : BASH_FUNCTIONS_BATCHED}
    `;
  script += zsh
    ? `
      echo "# Shell Options" >> "$SNAPSHOT_FILE"
      setopt | command awk 'NF == 1 || $2 == "on" { print "setopt " $1 }' | head -n 1000 >> "$SNAPSHOT_FILE"
    `
    : `
      echo "# Shell Options" >> "$SNAPSHOT_FILE"
      set -o | awk '$2 == "on" || $1 == "monitor" {print "set -o " $1}' >> "$SNAPSHOT_FILE"
      echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"
    `;
  return (script += `
      echo "# Aliases" >> "$SNAPSHOT_FILE"
      # Filter out winpty aliases on Windows to avoid "stdin is not a tty" errors
      # Git Bash automatically creates aliases like "alias node='winpty node.exe'" for
      # programs that need Win32 Console in mintty, but winpty fails when there's no TTY
      if [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then
        # sed, not grep -v, whose exit 1 when no alias is left ends this script under errexit and pipefail.
        # Every line gets "alias -- " here: the filter works by line, so it can leave part of a multi-line alias behind.
        alias | sed -e "/='winpty /d" | sed -e '1001,$d' -e 's/^alias //g' -e 's/^/alias -- /' >> "$SNAPSHOT_FILE"
      else
        ${zsh ? "alias | sed -e '1001,$d' -e 's/^alias //g' -e 's/^/alias -- /'" : "\\alias -p | sed -e '1001,$d' -e 's/^alias -- /alias /' -e 's/^alias /alias -- /'"} >> "$SNAPSHOT_FILE"
      fi
  `);
}

/** Iws(): pkill refuses a pattern that matches the CLI's own process. */
const PKILL_GUARD = [
  "unalias pkill 2>/dev/null || true",
  "function pkill {",
  '  if [ -n "${CLAUDE_PID:-}" ] && [ -r "/proc/${CLAUDE_PID}/comm" ]; then',
  '    local _cc_skip="" _cc_a',
  "    local -a _cc_probe=()",
  '    for _cc_a in ${1+"$@"}; do',
  '      if [ -n "$_cc_skip" ]; then _cc_skip=""; continue; fi',
  '      case "$_cc_a" in',
  "        --signal) _cc_skip=1 ;;",
  "        --signal=*|-e|--echo) ;;",
  "        -[0-9]*) ;;",
  '        -[PUGOF]?*) _cc_probe+=("$_cc_a") ;;',
  "        -[ABCDEFGHIJKLMNOPQRSTUVWXYZ][ABCDEFGHIJKLMNOPQRSTUVWXYZ0-9]*) ;;",
  '        *) _cc_probe+=("$_cc_a") ;;',
  "      esac",
  "    done",
  '    if command pgrep ${_cc_probe[@]+"${_cc_probe[@]}"} 2>/dev/null | command grep -qx "${CLAUDE_PID}"; then',
  "      printf 'pkill: refusing to run — this pattern matches the Claude CLI process (PID %s). Narrow the pattern, or target your own children with `pkill -P $$ ...`.\\n' \"${CLAUDE_PID}\" >&2",
  "      return 1",
  "    fi",
  "  fi",
  '  command pkill ${1+"$@"}',
  "}",
].join("\n");

/**
 * Gws(): what Claude Code itself adds, in a quoted here-document: the pkill
 * guard and the CLI's own PATH. tau has no embedded rg, bfs or ugrep, so the
 * rg alias and the find/grep shadows (which the original adds only when it
 * embeds them) never apply.
 */
function claudeAdditions(pathValue: string, delimiter: string): string {
  const body = [
    "# Shadow pkill to refuse patterns matching the CLI process",
    PKILL_GUARD,
    `export PATH=${shellQuote(pathValue)}`,
  ];
  return `
      cat >> "$SNAPSHOT_FILE" << '${delimiter}'
${body.join("\n")}
${delimiter}
  `;
}

interface SnapshotScriptFacts {
  file: string;
  rcFile: string;
  rcExists: boolean;
  /** The CLI's PATH, which the snapshot pins (the rc file's PATH is not kept). */
  path: string;
  platform: NodeJS.Platform;
  /** CLAUDE_CODE_END_<random>: the here-document's end word. */
  delimiter: string;
}

/** zws(): the script the snapshot shell runs. */
function snapshotScript(facts: SnapshotScriptFacts): string {
  const capture = facts.rcExists
    ? userConfigCapture(facts.rcFile, facts.platform)
    : facts.rcFile.endsWith(".zshrc")
      ? ""
      : 'echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"';
  return `SNAPSHOT_FILE=${shellQuote(facts.file)}
      ${facts.rcExists ? `source "${facts.rcFile}" < /dev/null` : "# No user config file to source"}
      

      # First, create/clear the snapshot file
      echo "# Snapshot file" >| "$SNAPSHOT_FILE"

      # When this file is sourced, we first unalias to avoid conflicts
      # This is necessary because aliases get "frozen" inside function definitions at definition time,
      # which can cause unexpected behavior when functions use commands that conflict with aliases
      echo "# Unset all aliases to avoid conflicts with functions" >> "$SNAPSHOT_FILE"
      echo "unalias -a 2>/dev/null || true" >> "$SNAPSHOT_FILE"

      ${capture}

      ${claudeAdditions(facts.path, facts.delimiter)}

      # Exit silently on success, only report errors
      if [ ! -f "$SNAPSHOT_FILE" ]; then
        echo "Error: Snapshot file was not created at $SNAPSHOT_FILE" >&2
        exit 1
      fi
    `;
}

const randomWord = (length: number) =>
  Math.random()
    .toString(36)
    .substring(2, 2 + length);

/** CLAUDE_CONFIG_DIR, else ~/.claude (Ye). */
const configDirectory = (env: NodeJS.ProcessEnv) =>
  env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude");

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

const created = new Set<string>();
let cleanupRegistered = false;
/** kt(): the session's snapshot is deleted when the process exits. */
function removeOnExit(file: string) {
  created.add(file);
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once("exit", () => {
    for (const each of created) {
      try {
        unlinkSync(each);
      } catch {
        /* Already gone. */
      }
    }
  });
}

/** OZn(): run the script in `<shell> -c -l`; the file must exist afterwards. */
async function createSnapshot(
  shell: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<SettledSnapshot> {
  try {
    const rc = rcFile(shell, env.HOME || homedir());
    const directory = path.join(configDirectory(env), "shell-snapshots");
    const file = path.join(
      directory,
      `snapshot-${shellKind(shell)}-${Date.now()}-${randomWord(6)}.sh`,
    );
    await mkdir(directory, { recursive: true });
    const script = snapshotScript({
      file,
      rcFile: rc,
      rcExists: await exists(rc),
      path: env.PATH ?? "",
      platform: process.platform,
      delimiter: `CLAUDE_CODE_END_${randomWord(16)}`,
    });
    const error = await new Promise<Error | null>((resolve) => {
      execFile(
        shell,
        ["-c", "-l", script],
        {
          env: {
            ...(env.CLAUDE_CODE_DONT_INHERIT_ENV ? {} : env),
            SHELL: shell,
            GIT_EDITOR: "true",
            CLAUDECODE: "1",
          },
          timeout: timeoutMs,
          maxBuffer: 1048576,
          encoding: "utf8",
        },
        (failure) => resolve(failure),
      );
    });
    if (error) return { kind: "failed", reason: error.message };
    if (!(await exists(file)))
      return { kind: "failed", reason: `no snapshot file at ${file}` };
    removeOnExit(file);
    return { kind: "ready", file };
  } catch (error) {
    return { kind: "failed", reason: String(error) };
  }
}

const states = new Map<string, SnapshotState>();

/**
 * Feo(): the snapshot for this shell, created once per process on first use
 * and shared by every shell host (the main session and its subagents).
 */
export function ensureSnapshot(
  shell: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = SNAPSHOT_TIMEOUT_MS,
): Promise<SettledSnapshot> {
  const key = [shell, env.HOME || homedir(), configDirectory(env)].join("\0");
  const state = states.get(key);
  if (state?.kind === "creating") return state.settled;
  if (state) return Promise.resolve(state);
  const settled = createSnapshot(shell, env, timeoutMs).then((result) => {
    states.set(key, result);
    return result;
  });
  states.set(key, { kind: "creating", settled });
  return settled;
}

/**
 * buildExecCommand(): the file to source, or undefined when the snapshot
 * failed or its file has gone, so this call spawns with `-l`.
 */
export async function usableSnapshot(
  shell: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const snapshot = await ensureSnapshot(shell, env);
  if (snapshot.kind !== "ready") return;
  try {
    await access(snapshot.file);
    return snapshot.file;
  } catch {
    return;
  }
}
