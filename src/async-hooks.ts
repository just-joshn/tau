import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import {
  asyncHookResponseTexts,
  escapeReminderText,
  type AsyncHookResponseAttachment,
} from "./attachments.js";
import {
  hookOutputSchema,
  type AsyncHookLaunch,
  type HookEvent,
  type HookResult,
} from "./hooks.js";

type JsonObject = Record<string, unknown>;

/** A finished config-async command's answer, held until the next model request (source `bCr`). */
export interface AsyncHookResponse {
  processId: string;
  hookName: string;
  hookEvent: HookEvent;
  toolName?: string;
  command: string;
  response: JsonObject;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Source `tGn` queue entry for an `asyncRewake` command that exited 2. */
export interface RewakeNotification {
  value: string;
  mode: "task-notification";
  priority: "next";
  stopHookActive: true;
  skipAttachments: true;
  turnAttribution: "inherit";
}

/**
 * How one config-async command ends. A `response` is held, then delivered by
 * the next `collect`. Everything else leaves the store at settlement.
 */
export type AsyncHookSettlement =
  | { kind: "killed" }
  | { kind: "silent" }
  | { kind: "response"; response: AsyncHookResponse }
  | { kind: "wake"; notification: RewakeNotification }
  | { kind: "no-wake" };

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Source `rgn`, the unbounded `HMe` reader of an ordinary host (`Lj()` false). */
function objectIn(text: string): JsonObject | undefined {
  if (!text.startsWith("{")) return;
  try {
    const parsed: unknown = JSON.parse(text);
    return object(parsed) ? parsed : undefined;
  } catch {
    return;
  }
}

/** Source `sgn`: one JSON answer after any leading `{"async":true}` line. */
export function readAsyncAnswer(stdout: string): JsonObject | undefined {
  const lines = stdout.trim().split("\n");
  const first = objectIn((lines[0] ?? "").trim());
  const candidates = [
    (first !== undefined && "async" in first ? lines.slice(1) : lines)
      .join("\n")
      .trim(),
    ...lines.map((line) => line.trim()),
  ];
  for (const candidate of candidates) {
    const value = objectIn(candidate);
    if (value !== undefined && !("async" in value)) return value;
  }
}

/** Source `agn`: the synchronous schema, else the recognized fields salvaged. */
export function admitAsyncAnswer(answer: JsonObject): JsonObject {
  const parsed = hookOutputSchema.safeParse(answer);
  if (parsed.success) return parsed.data;
  const salvaged: JsonObject = {};
  if (typeof answer.systemMessage === "string")
    salvaged.systemMessage = answer.systemMessage;
  if (object(answer.metrics))
    salvaged.metrics = Object.fromEntries(
      Object.entries(answer.metrics).filter(
        ([, value]) => typeof value === "boolean" || typeof value === "number",
      ),
    );
  if (object(answer.hookSpecificOutput)) {
    const { additionalContext, ...rest } = answer.hookSpecificOutput;
    salvaged.hookSpecificOutput =
      typeof additionalContext === "string" ? answer.hookSpecificOutput : rest;
  }
  return salvaged;
}

/** Source `TCr`/`bCr` for an `async` command (no plain-output context branch). */
export function settleAsyncResponse(
  launch: AsyncHookLaunch,
  processId: string,
  result: HookResult,
): AsyncHookSettlement {
  if (
    result.status === "cancelled" ||
    result.timedOut === true ||
    result.outputExceeded === true ||
    result.exitCode === null
  )
    return { kind: "killed" };
  const answer = readAsyncAnswer(result.stdout);
  const response = answer === undefined ? {} : admitAsyncAnswer(answer);
  if (
    Object.keys(response).length === 0 &&
    result.exitCode === 0 &&
    !result.stderr.trim()
  )
    return { kind: "silent" };
  return {
    kind: "response",
    response: {
      processId,
      hookName: launch.hookName,
      hookEvent: launch.event,
      ...(launch.toolName === undefined ? {} : { toolName: launch.toolName }),
      command: launch.command,
      response,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    },
  };
}

export interface ScriptPath {
  path: string;
  cutFrom?: string;
}
const SCRIPT_EXTENSION = /\.[A-Za-z][A-Za-z0-9]*$/;
const REDIRECT = /^(?:\d*|&)[<>]/;
const REDIRECT_ONLY = /^(?:\d*|&)[<>]{1,2}$/;
const INTERPRETED =
  /^\s*(?:\/(?:[\w.-]+\/)*)?(?:python[\d.]*|perl|sh|bash|dash)[ \t]+(\$(?:\{(?:CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR|HOME)\}|(?:CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR|HOME)\b)[\w./-]*)(?:[ \t]+[\w./=:@%+,-]+)*\s*$/;

/** Source `OCr`: shell words without redirections. */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = "",
    open = false,
    quote: string | undefined;
  for (let index = 0; index < command.length; index++) {
    const char = command.charAt(index);
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else word += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      open = true;
    } else if (char === "\\" && index + 1 < command.length) {
      word += command.charAt(++index);
      open = true;
    } else if (/\s/.test(char)) {
      if (open) words.push(word);
      word = "";
      open = false;
    } else {
      word += char;
      open = true;
    }
  }
  if (open) words.push(word);
  return words.filter(
    (value, index) =>
      !REDIRECT.test(value) && !REDIRECT_ONLY.test(words[index - 1] ?? ""),
  );
}

/** Source `mPo` on a POSIX host: absolute script paths an `asyncRewake` command names. */
export function rewakeScriptPaths(input: {
  command: string;
  args?: readonly string[];
  pluginRoot?: string;
  projectDir: string;
  homeDir: string;
  posixShell: boolean;
}): ScriptPath[] {
  const shell = input.args === undefined;
  const words =
    input.args === undefined
      ? shellWords(input.command)
      : [input.command, ...input.args];
  const interpreted =
    shell && input.posixShell
      ? INTERPRETED.exec(input.command)?.[1]
      : undefined;
  const paths: ScriptPath[] = [];
  for (const word of words) {
    if (!SCRIPT_EXTENSION.test(word)) continue;
    let path = word.replaceAll("${CLAUDE_PROJECT_DIR}", () => input.projectDir);
    if (input.pluginRoot !== undefined) {
      const root = input.pluginRoot;
      path = path.replaceAll("${CLAUDE_PLUGIN_ROOT}", () => root);
    }
    if (shell) {
      path = path
        .replace(/^(?:~(?=[\\/])|\$HOME\b|\$\{HOME\})/, () => input.homeDir)
        .replace(/\$CLAUDE_PROJECT_DIR\b/g, () => input.projectDir);
      if (input.pluginRoot !== undefined) {
        const root = input.pluginRoot;
        path = path.replace(/\$CLAUDE_PLUGIN_ROOT\b/g, () => root);
      }
    }
    if (/[$`*?[]/.test(path) || !isAbsolute(path)) continue;
    paths.push({ path });
    const cut =
      word === interpreted ? /^[^ \t\n]+(?= )/.exec(path)?.[0] : undefined;
    if (cut !== undefined) paths.push({ path: cut, cutFrom: path });
  }
  return paths;
}

const CANNOT_OPEN =
  /^(?:(?:[A-Za-z]:\\[^:]*|[^\s:]+): )?(?:\d+: )?(?:[Cc]an't|cannot) open (?:file |perl script )?(?:(['"])(.+?)\1[:( ]|([^'"]+?): )/;
const pathKey = (path: string) => {
  const normalized = path.replace(/[\\/]+/g, "/");
  return /^[A-Za-z]:\//.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
};

/** Source `hPo`: exit 2 only because the interpreter could not open a named script. */
export async function unopenedRewakeScript(input: {
  stdout: string;
  stderr: string;
  scriptPaths: readonly string[];
}): Promise<{ scriptPath: string; output: string } | undefined> {
  if (
    input.scriptPaths.length === 0 ||
    (input.stdout.trim() && input.stderr.trim())
  )
    return;
  const output = input.stderr.trim() ? input.stderr : input.stdout;
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return;
  const known = new Map(input.scriptPaths.map((path) => [pathKey(path), path]));
  const named = new Set<string>();
  for (const line of lines) {
    const match = CANNOT_OPEN.exec(line);
    const path = match?.[2] ?? match?.[3];
    const script = path === undefined ? undefined : known.get(pathKey(path));
    if (script === undefined) return;
    named.add(script);
  }
  for (const path of named)
    if (
      await access(path, constants.R_OK).then(
        () => true,
        () => false,
      )
    )
      return;
  const [scriptPath] = named;
  return scriptPath === undefined ? undefined : { scriptPath, output };
}

const REPEAT_LIMIT = 64;
/** Source `eGn`: true when this hook already reported the same unopened script. */
function repeatedFailure(
  seen: Map<string, string>,
  key: string,
  output: string | undefined,
): boolean {
  if (output === undefined) {
    seen.delete(key);
    return false;
  }
  if (seen.get(key) === output) return true;
  seen.delete(key);
  seen.set(key, output);
  if (seen.size > REPEAT_LIMIT) {
    const [oldest] = seen.keys();
    if (oldest !== undefined) seen.delete(oldest);
  }
  return false;
}

/** Source `tn`. */
const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Source `tGn` -> `ji({summary, trailing: "\n" + qs(body)})` with no task fields. */
export function rewakeNotification(
  summary: string,
  body: string,
): RewakeNotification {
  const trailing = `\n<system-reminder>\n${body}\n</system-reminder>`.replace(
    /<(?=\s*\/\s*task-notification\b)/gi,
    "&lt;",
  );
  return {
    value: `<task-notification>\n<summary>${escapeXml(summary)}</summary>\n</task-notification>${trailing}`,
    mode: "task-notification",
    priority: "next",
    stopHookActive: true,
    skipAttachments: true,
    turnAttribution: "inherit",
  };
}

/** Source `fxt` `asyncRewake` branch for a settings command (no plugin JSON summary). */
export async function settleRewake(
  launch: AsyncHookLaunch,
  result: HookResult,
  context: { homeDir: string; posixShell: boolean; seen: Map<string, string> },
): Promise<AsyncHookSettlement> {
  const { stdout, stderr } = result;
  const paths = rewakeScriptPaths({
    command: launch.hook.command,
    ...(launch.hook.args === undefined ? {} : { args: launch.hook.args }),
    ...(launch.origin.pluginRoot === undefined
      ? {}
      : { pluginRoot: launch.origin.pluginRoot }),
    projectDir: launch.projectDir,
    homeDir: context.homeDir,
    posixShell: context.posixShell,
  });
  const unopened =
    result.exitCode === 2
      ? await unopenedRewakeScript({
          stdout,
          stderr,
          scriptPaths: paths.map((entry) => entry.path),
        })
      : undefined;
  if (
    repeatedFailure(
      context.seen,
      `${launch.hookName}\n${launch.command}`,
      unopened?.output,
    ) ||
    result.exitCode !== 2
  )
    return { kind: "no-wake" };
  let lead: string, summary: string, detail: string;
  if (unopened !== undefined) {
    const cutFrom = paths.find(
      (entry) => entry.path === unopened.scriptPath,
    )?.cutFrom;
    lead = `${launch.hookName} hook could not run: ${unopened.scriptPath} cannot be opened${cutFrom === undefined ? "" : ` (the hook's command passes ${cutFrom} without quotes, so the shell split it at the space)`}, so its command exited with code 2 without doing any work. This is a broken hook installation, not feedback on your work; it is reported this once and identical repeats are dropped. Interpreter output:`;
    summary =
      cutFrom === undefined
        ? `${launch.event} hook could not open ${basename(unopened.scriptPath)}`
        : `${launch.event} hook needs quotes around a path with a space (${basename(cutFrom)})`;
    detail = unopened.output;
  } else {
    lead =
      launch.hook.rewakeMessage ??
      `Stop hook blocking error from command "${launch.hookName}":`;
    summary = launch.hook.rewakeSummary ?? "Stop hook feedback";
    detail = stderr || stdout;
  }
  return {
    kind: "wake",
    notification: rewakeNotification(
      summary,
      escapeReminderText(`${lead} ${detail}`),
    ),
  };
}

/** Source `Oro` over the async SessionStart answers this store already delivered. */
function sessionStartDuplicate(
  reply: { response: JsonObject; command: string },
  history: readonly AsyncHookResponseAttachment[],
): boolean {
  const texts = asyncHookResponseTexts(reply.response);
  if (texts.length === 0) return false;
  for (let index = history.length - 1; index >= 0; index--) {
    const prior = history[index];
    if (prior?.hookEvent !== "SessionStart") continue;
    const priorTexts = asyncHookResponseTexts(prior.response);
    const same = prior.command === reply.command;
    if (prior.command !== undefined && !same) continue;
    if (priorTexts.length > 0)
      return texts.every((text) => priorTexts.includes(text));
    if (same && prior.exitCode === 0) return false;
  }
  return false;
}

export interface AsyncHookOwnerOptions {
  enqueueWake(notification: RewakeNotification): void;
  homeDir: string;
  /** False under PowerShell or a `CLAUDE_CODE_SHELL_PREFIX`. */
  posixShell(hook: AsyncHookLaunch["hook"]): boolean;
}

/** Bxs: how long a print run waits for unfinished `asyncRewake` commands after its result. */
export const REWAKE_EXIT_WAIT_MS = 30_000;

/**
 * Source `lgn` store plus `fxt`/`ggn`/`uAs`. A launch is pending until its
 * command settles. A response is then held until `collect` delivers it once.
 * Rewakes are tracked apart (source `tlo`) and never produce a response.
 */
export class AsyncHookOwner {
  readonly #pending = new Map<string, AsyncHookLaunch>();
  #held: AsyncHookResponse[] = [];
  readonly #delivered: AsyncHookResponseAttachment[] = [];
  readonly #rewakes = new Set<Promise<void>>();
  readonly #seen = new Map<string, string>();
  #next = 0;
  #closed = false;
  constructor(private readonly options: AsyncHookOwnerOptions) {}

  admit(launch: AsyncHookLaunch): void {
    if (this.#closed) return;
    if (launch.hook.asyncRewake === true) {
      const running = launch.completion
        .then(async (result) => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          const settled = await settleRewake(launch, result, {
            homeDir: this.options.homeDir,
            posixShell: this.options.posixShell(launch.hook),
            seen: this.#seen,
          });
          if (settled.kind === "wake")
            this.options.enqueueWake(settled.notification);
        })
        .catch(() => {});
      this.#rewakes.add(running);
      void running.finally(() => this.#rewakes.delete(running));
      return;
    }
    const processId = `async_hook_${++this.#next}`;
    this.#pending.set(processId, launch);
    void launch.completion.then(
      (result) => {
        if (!this.#pending.delete(processId)) return;
        const settled = settleAsyncResponse(launch, processId, result);
        if (settled.kind === "response") this.#held.push(settled.response);
      },
      () => this.#pending.delete(processId),
    );
  }

  /** Source `ggn` + `uAs`: take every held response once, as attachments. */
  collect(): AsyncHookResponseAttachment[] {
    const responses = this.#held;
    this.#held = [];
    const attachments: AsyncHookResponseAttachment[] = [];
    for (const response of responses) {
      const sessionStart = response.hookEvent === "SessionStart";
      if (
        sessionStart &&
        sessionStartDuplicate(
          { response: response.response, command: response.command },
          this.#delivered,
        )
      )
        continue;
      const { command, ...rest } = response;
      const attachment: AsyncHookResponseAttachment = {
        type: "async_hook_response",
        ...rest,
        ...(sessionStart ? { command } : {}),
      };
      attachments.push(attachment);
      this.#delivered.push(attachment);
    }
    return attachments;
  }

  /** Source `Y$s`: wait for unfinished rewakes, at most `timeoutMs`. */
  async settleRewakes(timeoutMs = REWAKE_EXIT_WAIT_MS): Promise<void> {
    if (this.#rewakes.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(this.#rewakes),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
  }

  /** Source `removeAll`: drop pending and undelivered responses. */
  close(): void {
    this.#closed = true;
    this.#pending.clear();
    this.#held = [];
  }
}
