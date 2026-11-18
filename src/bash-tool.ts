/**
 * Bash tool execution: the shell session (persistent cwd), one command run,
 * its outcome and the tool_result text the model receives. Recovered from
 * chunk-4h798pp0's Bash tool (call, zxi, v0e, buildExecCommand,
 * mapToolResultToToolResultBlockParam, h0o, _0o, Eq/HLr).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { copyFile, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { homedir, constants as osConstants } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  bashDescription,
  bashInputSchema,
  bashPromptFacts,
  type BashPromptFacts,
  type BashSessionKind,
} from "./bash-description.js";
import { describedShell, selectShell } from "./bash-shell.js";
import {
  createBackgroundShells,
  type BackgroundShells,
  type RunningShell,
  type ShellCompletion,
} from "./background-shells.js";
import { integerSetting } from "./env-settings.js";
import { createNativeBashCommandProjection } from "./native-bash-command-projection.js";
import { createNativeBashParser } from "./native-bash-parser.js";
import { encodeNativeProjectDirectoryName } from "./native-storage-paths.js";
import type { ToolDefinition } from "./types.js";

/** Characters other than tab and newline that an approval dialog would hide (Mh). */
const hidden = (text: string) =>
  Array.from(text).some((char) => {
    const code = char.charCodeAt(0);
    return (
      code !== 9 && code !== 10 && (code < 32 || (code >= 127 && code <= 159))
    );
  });
const numeric = (value: unknown) => {
  if (typeof value !== "string") return value;
  const text = value.trim();
  return /^[-+]?\d+(\.\d+)?$/.test(text) && Number.isFinite(Number(text))
    ? Number(text)
    : value;
};
const flag = (value: unknown) =>
  value === "true" ? true : value === "false" ? false : value;
const inputFields = {
  command: z
    .string()
    .refine(
      (value) => !hidden(value),
      "command contains control characters that would be hidden in the approval dialog",
    ),
  timeout: z.preprocess(numeric, z.number().optional()),
  description: z.string().optional(),
  dangerouslyDisableSandbox: z.preprocess(flag, z.boolean().optional()),
};
const withBackground = z.strictObject({
  ...inputFields,
  run_in_background: z.preprocess(flag, z.boolean().optional()),
});
const foregroundOnly = z.strictObject(inputFields);
export type BashInput = z.infer<typeof withBackground>;
export function parseBashInput(
  value: unknown,
  backgroundDisabled: boolean,
): BashInput {
  return backgroundDisabled
    ? foregroundOnly.parse(value)
    : withBackground.parse(value);
}

let splitter: ((command: string) => string[]) | undefined;
/** Sy: the command's simple commands, split by the recovered bash grammar. */
function subcommands(command: string): string[] {
  splitter ??= createNativeBashCommandProjection(
    createNativeBashParser(),
  ).splitCommands;
  try {
    return splitter(command);
  } catch {
    return [command];
  }
}
const firstWord = (text: string) => text.trim().split(/\s+/)[0] ?? "";

/** eHt/KEi: exit-code meaning by the last simple command. */
const QUIET_ONE: Record<string, string> = {
  grep: "No matches found",
  rg: "No matches found",
  egrep: "No matches found",
  fgrep: "No matches found",
  find: "Some directories were inaccessible",
  diff: "Files differ",
  test: "Condition is false",
  "[": "Condition is false",
};
function gitSubcommand(words: readonly string[]): string | undefined {
  if (words[0] !== "git") return;
  for (let index = 1; index < words.length; index++) {
    const word = words[index] ?? "";
    if (word.startsWith("-")) {
      if (word === "-C" || word === "-c") index++;
      continue;
    }
    return word;
  }
}
export function interpretExit(command: string, code: number): ShellCompletion {
  const last = subcommands(command).at(-1) || command;
  const words = last.trim().split(/\s+/);
  const git = gitSubcommand(words);
  const note =
    git === "grep"
      ? "No matches found"
      : git === "diff"
        ? "Files differ"
        : words[0] === "git"
          ? undefined
          : QUIET_ONE[words[0] ?? ""];
  if (note === undefined)
    return { status: code === 0 ? "completed" : "failed" };
  if (code >= 2) return { status: "failed" };
  return code === 1
    ? { status: "completed", exitNote: note }
    : { status: "completed" };
}

/** Uxi: a leading `sleep N` (N >= 25) in the foreground is refused. */
export function leadingSleep(command: string): string | undefined {
  const parts = subcommands(command);
  const match = /^sleep\s+(\d+(?:\.\d*)?)\s*$/.exec(parts[0]?.trim() ?? "");
  if (!match) return;
  const seconds = parseFloat(match[1] ?? "0");
  if (seconds < 25) return;
  const rest = parts.slice(1).join(" ").trim();
  return rest
    ? `sleep ${seconds} followed by: ${rest}`
    : `standalone sleep ${seconds}`;
}
/** Hxi: a command starting with `sleep` is never moved to the background on timeout. */
const movableOnTimeout = (command: string) =>
  firstWord(subcommands(command)[0] ?? "") !== "sleep";
const NO_OUTPUT_COMMANDS = new Set([
  "mv",
  "cp",
  "rm",
  "mkdir",
  "rmdir",
  "chmod",
  "chown",
  "chgrp",
  "touch",
  "ln",
  "cd",
  "export",
  "unset",
  "wait",
]);
/** Oxi: every simple command is one that normally prints nothing. */
function noOutputExpected(command: string): boolean {
  let any = false;
  for (const part of subcommands(command)) {
    const word = firstWord(part);
    if (!word) continue;
    any = true;
    if (!NO_OUTPUT_COMMANDS.has(word)) return false;
  }
  return any;
}

/** bn(): 1s, 2m 0s, 1h 0m 0s. */
export function formatDuration(ms: number, hideTrailingZeros = false): string {
  if (ms < 60000) {
    if (ms === 0) return "0s";
    if (ms < 1) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 1000)}s`;
  }
  let days = Math.floor(ms / 86400000),
    hours = Math.floor((ms % 86400000) / 3600000),
    minutes = Math.floor((ms % 3600000) / 60000),
    seconds = Math.round((ms % 60000) / 1000);
  if (seconds === 60) {
    seconds = 0;
    minutes++;
  }
  if (minutes === 60) {
    minutes = 0;
    hours++;
  }
  if (hours === 24) {
    hours = 0;
    days++;
  }
  const hide = hideTrailingZeros;
  if (days > 0) {
    if (hide && hours === 0 && minutes === 0) return `${days}d`;
    if (hide && minutes === 0) return `${days}d ${hours}h`;
    return `${days}d ${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    if (hide && minutes === 0 && seconds === 0) return `${hours}h`;
    if (hide && seconds === 0) return `${hours}h ${minutes}m`;
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    if (hide && seconds === 0) return `${minutes}m`;
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
/** rn(): 1023 bytes, 2KB, 1.5MB. */
export function formatSize(bytes: number): string {
  const kb = bytes / 1024;
  if (kb < 1) return `${bytes} bytes`;
  const fixed = (value: number) => value.toFixed(1).replace(/\.0$/, "");
  if (kb < 1024) return `${fixed(kb)}KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${fixed(mb)}MB`;
  return `${fixed(mb / 1024)}GB`;
}
/** jun(): drop whitespace-only lines at both ends. */
function trimBlankLines(text: string): string {
  const lines = text.split("\n");
  let first = 0,
    last = lines.length - 1;
  while (first < lines.length && lines[first]?.trim() === "") first++;
  while (last >= 0 && lines[last]?.trim() === "") last--;
  return first > last ? "" : lines.slice(first, last + 1).join("\n");
}
/** bh(): error text above 11024 characters keeps 5000 at each end. */
function boundedError(text: string): string {
  const keep = 10000;
  if (text.length <= keep + 1024) return text;
  const head = text.slice(0, keep / 2),
    tail = text.slice(-keep / 2);
  return `${head}\n\n... [${text.length - keep} characters truncated] ...\n\n${tail}`;
}
const PREVIEW_BYTES = 2000;
/** ofe()/xje(): the persisted-output envelope for output over the inline limit. */
function persistedPreview(output: string, file: string, size: number): string {
  let preview = output,
    more = false;
  if (output.length > PREVIEW_BYTES) {
    const newline = output.slice(0, PREVIEW_BYTES).lastIndexOf("\n");
    preview = output.slice(
      0,
      newline > PREVIEW_BYTES / 2 ? newline : PREVIEW_BYTES,
    );
    more = true;
  }
  return `<persisted-output>\nOutput too large (${formatSize(size)}). Full output saved to: ${file}\n\nPreview (first ${formatSize(PREVIEW_BYTES)}):\n${preview}${more ? "\n...\n" : "\n"}</persisted-output>`;
}

/** What one Bash call produced, before it becomes model text. */
export type BashOutcome =
  | { kind: "completed"; output: string; cwdNote?: string }
  | { kind: "failed"; code: number; output: string }
  | {
      kind: "background";
      taskId: string;
      outputFile: string;
      output: string;
      timedOutAfterMs?: number;
    }
  | { kind: "refused"; message: string };

export interface RenderFacts {
  /** DC(): print/SDK session; its launch text points at the output file. */
  nonInteractive: boolean;
  backgroundDeadlineMs?: number;
}
/** h0o(): the background part of the tool_result. */
function backgroundText(
  outcome: Extract<BashOutcome, { kind: "background" }>,
  facts: RenderFacts,
): string {
  const { taskId: id, outputFile: file, timedOutAfterMs } = outcome;
  const moved = timedOutAfterMs !== undefined;
  const seconds = Math.max(1, Math.round((timedOutAfterMs ?? 0) / 1000));
  const quiet = !moved && !facts.nonInteractive;
  return [
    moved
      ? `Command did not complete within its ${seconds}s timeout and was moved to the background (ID: ${id}). Output is being written to: ${file}.`
      : `Command running in background with ID: ${id}. Output is being written to: ${file}.`,
    quiet
      ? "You will be notified when it completes — do not poll that file or sleep while waiting."
      : "You will be notified when it completes.",
    moved && facts.backgroundDeadlineMs !== undefined
      ? `If it is still running after ${formatDuration(facts.backgroundDeadlineMs, true)} in the background, it will be stopped and you will be notified.`
      : undefined,
    moved
      ? "It is running now: do not start a second copy while it runs. If it is no longer needed, stop it with TaskStop."
      : undefined,
    moved && outcome.output === ""
      ? "No output had been read from it when it was moved. A program that buffers its output, or a pipe into one such as tail, can keep the output file empty until the command finishes."
      : undefined,
    quiet
      ? "Read the file only if the user asks for progress, or if you need a line it prints before you can go on, such as a server's ready line or port."
      : "To check interim output, use Read on that file path.",
  ]
    .filter(Boolean)
    .join(" ");
}
/** mapToolResultToToolResultBlockParam + Eq: the model-visible text. */
export function renderBashOutcome(
  outcome: BashOutcome,
  facts: RenderFacts,
): { content: string; is_error: boolean } {
  switch (outcome.kind) {
    case "completed": {
      const content = [
        outcome.output.replace(/^(\s*\n)+/, "").trimEnd(),
        outcome.cwdNote,
      ]
        .filter(Boolean)
        .join("\n");
      return {
        content:
          content.trim() === "" ? "(Bash completed with no output)" : content,
        is_error: false,
      };
    }
    case "failed":
      return {
        content: boundedError(
          [`Exit code ${outcome.code}`, outcome.output]
            .filter(Boolean)
            .join("\n")
            .trim() || "Command failed with no output",
        ),
        is_error: true,
      };
    case "background":
      return {
        content: [
          outcome.output.replace(/^(\s*\n)+/, "").trimEnd(),
          backgroundText(outcome, facts),
        ]
          .filter(Boolean)
          .join("\n"),
        is_error: false,
      };
    case "refused":
      return { content: outcome.message, is_error: true };
    default: {
      const exhaustive: never = outcome;
      throw new Error(`Unknown Bash outcome: ${String(exhaustive)}`);
    }
  }
}

const KILL_GRACE_MS = 1500;
const TIMEOUT_CODE = 143;
const signalCode = (signal: NodeJS.Signals | null) =>
  signal ? 128 + (osConstants.signals[signal] ?? 0) : 1;
/** Single-quote for `eval`, with the original's `'"'"'` escape (LZn). */
const quote = (text: string) => `'${text.replaceAll("'", `'"'"'`)}'`;
const HEREDOC = /<<-?\s*['"]?[A-Za-z_]/;
const INPUT_REDIRECT = /(?:^|[\s;&|])<(?![<(])\s*\S+/;
/** buildExecCommand(): shell options, the quoted command, then record `pwd -P`. */
function commandString(
  shell: string,
  command: string,
  cwdFile: string,
): string {
  const steps: string[] = [];
  if (shell.includes("bash"))
    steps.push("\\builtin shopt -u extglob 2>/dev/null || true");
  else if (shell.includes("zsh"))
    steps.push(
      "\\builtin setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL NO_BRACE_CCL NO_MAGIC_EQUAL_SUBST 2>/dev/null || true",
    );
  steps.push(
    "{ \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true",
  );
  const stdinFree = !HEREDOC.test(command) && !INPUT_REDIRECT.test(command);
  steps.push(`eval ${quote(command)}${stdinFree ? " < /dev/null" : ""}`);
  steps.push(`pwd -P >| ${quote(cwdFile)}`);
  return steps.join(" && ");
}

function spawnShell(request: {
  shell: string;
  command: string;
  cwd: string;
  cwdFile: string;
  outputFile: string;
  env: NodeJS.ProcessEnv;
}): RunningShell & { pid: number | undefined } {
  const fd = openSync(request.outputFile, "w");
  let child;
  try {
    child = spawn(
      request.shell,
      [
        "-c",
        "-l",
        commandString(request.shell, request.command, request.cwdFile),
      ],
      {
        cwd: request.cwd,
        env: request.env,
        detached: true,
        stdio: ["ignore", fd, fd],
      },
    );
  } finally {
    closeSync(fd);
  }
  const exited = new Promise<number>((resolve) => {
    child.on("error", () => resolve(126));
    child.on("exit", (code, signal) => resolve(code ?? signalCode(signal)));
  });
  const group = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      /* Already gone. */
    }
  };
  let killing: Promise<number> | undefined;
  return {
    pid: child.pid,
    outputFile: request.outputFile,
    exited,
    kill() {
      killing ??= (async () => {
        group("SIGTERM");
        const timer = setTimeout(() => group("SIGKILL"), KILL_GRACE_MS);
        const code = await exited;
        clearTimeout(timer);
        group("SIGKILL");
        return code;
      })();
      return killing;
    },
  };
}

/** TaskOutput.getStdout(): the first `limit` bytes, and the file size. */
async function readHead(file: string, limit: number) {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, limit));
    await handle.read(buffer, 0, buffer.length, 0);
    return { text: buffer.toString("utf8"), size };
  } finally {
    await handle.close();
  }
}
/** lNo()/sqs(): the last 2000 bytes from the first full line. */
async function readTail(file: string): Promise<string> {
  try {
    const bytes = await readFile(file);
    if (bytes.length <= PREVIEW_BYTES) return bytes.toString("utf8");
    const tail = bytes.subarray(bytes.length - PREVIEW_BYTES).toString("utf8");
    return `[… earlier output omitted; full output: ${file}]\n${tail.slice(tail.indexOf("\n") + 1)}`;
  } catch {
    return "";
  }
}

export interface ShellHostOptions {
  startCwd: string;
  env?: NodeJS.ProcessEnv;
  sessionId?: () => string;
  session?: BashSessionKind;
  /** Subagents never carry `cd` to the next call. */
  mainThread?: boolean;
  shells?: BackgroundShells;
}
/**
 * One session's shell: the start folder, the cwd the next call starts in,
 * and the background registry. Rebuilt tool executors share it.
 */
export function createShellHost(options: ShellHostOptions) {
  const env = options.env ?? process.env;
  const session = options.session ?? { nonInteractive: true, singleShot: true };
  const mainThread = options.mainThread ?? true;
  const startCwd = options.startCwd;
  let cwd = startCwd;
  const shells =
    options.shells ??
    createBackgroundShells({
      interpret: interpretExit,
      enqueueNotification() {},
    });
  const facts = (): BashPromptFacts =>
    bashPromptFacts(env, describedShell(env), session);
  const tmpRoot = () => env.CLAUDE_CODE_TMPDIR || "/tmp";
  /** kc()/St(): <tmp>/claude-<uid>/<project>/<session>/tasks. */
  function tasksDirectory(): string {
    const root = path.join(tmpRoot(), `claude-${process.getuid?.() ?? 0}`);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const directory = path.join(
      realpathSync(root),
      encodeNativeProjectDirectoryName(startCwd),
      options.sessionId?.() ?? "session",
      "tasks",
    );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
  }
  /** qCt(): <config>/projects/<project>/<session>/tool-results/<id>.txt. */
  const toolResultsFile = (id: string) =>
    path.join(
      env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"),
      "projects",
      encodeNativeProjectDirectoryName(startCwd),
      options.sessionId?.() ?? "session",
      "tool-results",
      `${id}.txt`,
    );
  const childEnv = (shell: string): NodeJS.ProcessEnv => ({
    ...env,
    SHELL: shell,
    GIT_EDITOR: "true",
    CLAUDECODE: "1",
    CLAUDE_CODE_EXECPATH: process.execPath,
    ...(options.sessionId
      ? { CLAUDE_CODE_SESSION_ID: options.sessionId() }
      : {}),
    CLAUDE_CODE_CHILD_SESSION: "1",
    CLAUDE_PID: String(process.pid),
  });
  const inside = (directory: string) => {
    const relative = path.relative(startCwd, directory);
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
  };
  /** S_ + _0o: adopt the recorded cwd, then return outside the working directories. */
  async function settleCwd(cwdFile: string): Promise<string | undefined> {
    let recorded: string | undefined;
    try {
      recorded = (await readFile(cwdFile, "utf8")).trim();
    } catch {
      /* The command failed before `pwd -P`; the cwd stays. */
    }
    await rm(cwdFile, { force: true });
    if (!mainThread) return;
    if (recorded) {
      try {
        if ((await stat(recorded)).isDirectory()) cwd = recorded;
      } catch {
        /* Gone already. */
      }
    }
    const maintain = facts().maintainProjectDir;
    if (maintain || (cwd !== startCwd && !inside(cwd))) {
      cwd = startCwd;
      if (!maintain) return `Shell cwd was reset to ${startCwd}`;
    }
  }
  /** Output within the inline limit is read and deleted; above it the file is kept as a tool result. */
  async function collect(file: string, id: string): Promise<string> {
    const limit = outputLimit(env);
    const { text, size } = await readHead(file, limit);
    if (size <= limit) {
      await rm(file, { force: true });
      return text;
    }
    const saved = toolResultsFile(id);
    await mkdir(path.dirname(saved), { recursive: true });
    await copyFile(file, saved);
    await rm(file, { force: true });
    return persistedPreview(trimBlankLines(text), saved, size);
  }
  /** Where the next call would run; a deleted folder falls back to the start folder (TCi). */
  async function liveCwd(): Promise<string | BashOutcome> {
    try {
      if ((await stat(cwd)).isDirectory()) return cwd;
    } catch {
      /* Recover below. */
    }
    const lost = cwd;
    cwd = startCwd;
    return {
      kind: "refused",
      message: `Working directory "${lost}" no longer exists, so this command was not run. Shell cwd recovered to "${startCwd}": re-issue the command if it still makes sense there.`,
    };
  }

  async function run(
    input: BashInput,
    context: { toolUseId?: string; signal: AbortSignal },
  ): Promise<BashOutcome> {
    const current = facts();
    const { timeouts } = current;
    const background =
      input.run_in_background === true && !current.backgroundDisabled;
    const requested =
      input.timeout && input.timeout > 0 ? input.timeout : undefined;
    const limit = Math.min(
      requested ?? timeouts.defaultMs,
      background ? timeouts.backgroundMaxMs : timeouts.maxMs,
    );
    const directory = await liveCwd();
    if (typeof directory !== "string") return directory;
    context.signal.throwIfAborted();
    const shell = selectShell(env);
    const id = `b${[...randomBytes(8)].map((byte) => "0123456789abcdefghijklmnopqrstuvwxyz"[byte % 36]).join("")}`;
    const outputFile = path.join(tasksDirectory(), `${id}.output`);
    const cwdFile = path.join(
      tmpRoot(),
      `claude-${randomBytes(2).toString("hex")}-cwd`,
    );
    const child = spawnShell({
      shell,
      command: input.command,
      cwd: directory,
      cwdFile,
      outputFile,
      env: childEnv(shell),
    });
    const description = input.description || input.command;
    const deadline = (explicit: number | undefined) =>
      current.backgroundDeadline
        ? (explicit ?? timeouts.backgroundDefaultMs)
        : explicit;
    const adopt = (deadlineMs: number | undefined) => {
      void rm(cwdFile, { force: true });
      shells.adopt(child, {
        id,
        command: input.command,
        description,
        ...(context.toolUseId === undefined
          ? {}
          : { toolUseId: context.toolUseId }),
        ...(deadlineMs === undefined ? {} : { deadlineMs }),
        ...(timeouts.backgroundMaxMs < 7200000
          ? { longestTimeoutMs: timeouts.backgroundMaxMs }
          : {}),
      });
    };
    if (background) {
      adopt(deadline(requested === undefined ? undefined : limit));
      return { kind: "background", taskId: id, outputFile, output: "" };
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    const ending = await new Promise<
      { kind: "exit"; code: number } | { kind: "timeout" } | { kind: "abort" }
    >((resolve) => {
      void child.exited.then((code) => resolve({ kind: "exit", code }));
      timer = setTimeout(() => resolve({ kind: "timeout" }), limit);
      onAbort = () => resolve({ kind: "abort" });
      context.signal.addEventListener("abort", onAbort, { once: true });
      if (context.signal.aborted) onAbort();
    }).finally(() => {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", onAbort);
    });

    if (ending.kind === "abort") {
      await child.kill();
      await rm(cwdFile, { force: true });
      await rm(outputFile, { force: true });
      throw new Error("Bash aborted");
    }
    if (ending.kind === "timeout") {
      if (!current.backgroundDisabled && movableOnTimeout(input.command)) {
        adopt(deadline(undefined));
        return {
          kind: "background",
          taskId: id,
          outputFile,
          output: await readTail(outputFile),
          timedOutAfterMs: limit,
        };
      }
      await child.kill();
      await rm(cwdFile, { force: true });
      const output = await collect(outputFile, id);
      const note = `Command timed out after ${formatDuration(limit)}`;
      return {
        kind: "failed",
        code: TIMEOUT_CODE,
        output: output ? `${note}\n${output}` : note,
      };
    }
    const output = await collect(outputFile, id);
    const cwdNote = await settleCwd(cwdFile);
    if (interpretExit(input.command, ending.code).status === "failed")
      return { kind: "failed", code: ending.code, output };
    return {
      kind: "completed",
      output: trimBlankLines(output),
      ...(cwdNote === undefined ? {} : { cwdNote }),
    };
  }

  return {
    shells,
    facts,
    get cwd() {
      return cwd;
    },
    definition(): ToolDefinition {
      const current = facts();
      return {
        name: "Bash",
        description: bashDescription(current),
        input_schema: bashInputSchema(current),
      };
    },
    parse(value: unknown): BashInput {
      return parseBashInput(value, facts().backgroundDisabled);
    },
    /** validateInput(): the long leading sleep refusal, as a tool_use_error. */
    refusal(input: BashInput): string | undefined {
      if (facts().backgroundDisabled || input.run_in_background === true)
        return;
      const sleep = leadingSleep(input.command);
      return sleep === undefined
        ? undefined
        : `<tool_use_error>Blocked: ${sleep}. To wait for a condition, use Monitor with an until-loop (e.g. \`until <check>; do sleep 2; done\`). To wait for a command you started, use run_in_background: true. Do not chain shorter sleeps to work around this block.</tool_use_error>`;
    },
    run,
    render(outcome: BashOutcome) {
      const current = facts();
      return renderBashOutcome(outcome, {
        nonInteractive: session.nonInteractive,
        ...(current.backgroundDeadline
          ? {
              backgroundDeadlineMs: Math.min(
                current.timeouts.backgroundDefaultMs,
                current.timeouts.backgroundMaxMs,
              ),
            }
          : {}),
      });
    },
    noOutputExpected,
  };
}
export type ShellHost = ReturnType<typeof createShellHost>;

/** Aj(): BASH_MAX_OUTPUT_LENGTH, default 30000, capped at 150000. */
export function outputLimit(env: NodeJS.ProcessEnv): number {
  const parsed = integerSetting(env.BASH_MAX_OUTPUT_LENGTH);
  if (parsed === undefined || parsed <= 0) return 30000;
  return Math.min(parsed, 150000);
}
