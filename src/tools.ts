import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { TextDecoder, isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type {
  PermissionMode,
  ToolDefinition,
  ToolExecutor,
  ToolResult,
  ToolUse,
} from "./types.js";
import {
  appendPreHookContext,
  appendFailureHookContext,
  type PreToolHookResult,
  type ToolFailureHookResult,
  type ToolHookRuntime,
} from "./tool-hook-runtime.js";
import { findRipgrep, grepInputSchema, searchText } from "./grep.js";
import { createGlobMatcher, MAX_GLOB_PATTERN } from "./glob.js";
import { applyEdit, editInputFields } from "./edit.js";
import { writeAtomic } from "./write.js";
import { readInputSchema } from "./read.js";
import {
  applyNotebookEdit,
  MAX_NOTEBOOK_BYTES,
  NOTEBOOK_EDIT_DESCRIPTION,
  notebookEditInputSchema,
  renderNotebook,
} from "./notebook-edit.js";
import { ReadState } from "./read-state.js";
import { prepareFileRestoration } from "./file-restoration.js";
import {
  FILE_READ_BYTES,
  FileReadByteLimit,
  FileReadTokenLimit,
  fileReadTokenLimit,
  largeReadHint,
  renderSelectedText,
  selectTextFile,
  type FileTokenCounter,
  type TextSelection,
} from "./file-read.js";
import { captureNativePersistenceJson } from "./native-persistence-events.js";
import { readAllowance, type ReadToolContext } from "./context-room.js";
import { MAX_EDIT_BYTES, readFileSnapshot } from "./file-snapshot.js";
import { sensitiveWriteReason } from "./permission-sensitive.js";
import { parseNativePermissionRule } from "./native-permission-rules.js";
import type { FilePermissionSessionResult } from "./file-permission-session.js";
import type { BashPermissionSessionResult } from "./bash-permission-session.js";
import { unparsedToolInput } from "./tool-input.js";
import {
  bashDescription,
  bashInputSchema,
  bashPromptFacts,
} from "./bash-description.js";
import { describedShell } from "./bash-shell.js";
import {
  createShellHost,
  parseBashInput,
  type ShellHost,
} from "./bash-tool.js";
import type {
  ToolApprovalAnswer,
  ToolApprovalRequest,
} from "./permission-dialog.js";
import { decodeTextFile, encodeTextFile } from "./text-file.js";
import {
  inheritedReadDeny,
  matchingToolRule,
  ToolInputRejected,
  ToolPermissionDenied,
  permissionDeniedMarkers,
  toolNameSchema,
  toolPolicySchema,
  type ToolName,
  type ToolPolicy,
  type PolicyRuleMatch,
} from "./tool-policy.js";

const MAX_BYTES = 64 * 1024;
const MAX_ENTRIES = 5000;
const ignored = new Set([".git", "node_modules", ".tau"]);
const fileInput = z.object({ file_path: z.string().min(1) });
const schemas = {
  Read: readInputSchema,
  Write: fileInput.extend({ content: z.string() }),
  Edit: fileInput.extend(editInputFields),
  Glob: z.strictObject({
    pattern: z
      .string()
      .min(1)
      .max(MAX_GLOB_PATTERN)
      .refine(
        (value) => !value.includes("\0"),
        "Glob pattern cannot contain NUL bytes",
      ),
    path: z
      .string()
      .refine(
        (value) => !value.includes("\0"),
        "Glob path cannot contain NUL bytes",
      )
      .default("."),
  }),
  Grep: grepInputSchema,
  NotebookEdit: notebookEditInputSchema,
};
function bounded(text: string): string {
  const bytes = Buffer.from(text);
  return bytes.length > MAX_BYTES
    ? new TextDecoder("utf-8", { ignoreBOM: true }).decode(
        bytes.subarray(0, MAX_BYTES),
        { stream: true },
      ) + "\n[output truncated]"
    : text;
}
/** A valid single-region text patch. Disjoint canonical diff grouping is a separate formatter gap. */
function textPatch(
  original: string,
  updated: string,
): Array<{
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}> {
  if (original === updated) return [];
  const split = (text: string) => {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines;
  };
  const before = split(original),
    after = split(updated);
  let first = 0,
    last = 0;
  while (
    first < Math.min(before.length, after.length) &&
    before[first] === after[first]
  )
    first++;
  if (
    original.endsWith("\n") !== updated.endsWith("\n") &&
    first === Math.min(before.length, after.length)
  )
    first = Math.max(0, first - 1);
  while (
    last < Math.min(before.length, after.length) - first &&
    before[before.length - 1 - last] === after[after.length - 1 - last]
  )
    last++;
  const start = Math.max(0, first - 4),
    tail = Math.min(4, last);
  const endBefore = before.length - last,
    endAfter = after.length - last;
  const lines: string[] = [];
  const append = (
    line: string,
    prefix: string,
    terminal: boolean,
    newline: boolean,
  ) => {
    lines.push(prefix + line);
    if (terminal && !newline) lines.push("\\ No newline at end of file");
  };
  const run = (
    rows: string[],
    from: number,
    to: number,
    prefix: string,
    newline: boolean,
  ) => {
    for (const [j, row] of rows.slice(from, to).entries())
      append(row, prefix, from + j + 1 === rows.length, newline);
  };
  run(before, start, first, " ", original.endsWith("\n"));
  run(before, first, endBefore, "-", original.endsWith("\n"));
  run(after, first, endAfter, "+", updated.endsWith("\n"));
  run(before, endBefore, endBefore + tail, " ", original.endsWith("\n"));
  return [
    {
      oldStart: before.length ? start + 1 : 0,
      oldLines: endBefore + tail - start,
      newStart: after.length ? start + 1 : 0,
      newLines: endAfter + tail - start,
      lines,
    },
  ];
}
export function toolDefinitions(
  names: readonly ToolName[],
  bash?: ShellHost,
): ToolDefinition[] {
  return names.map((name) => {
    if (name === "Bash") {
      if (bash) return bash.definition();
      const facts = bashPromptFacts(process.env, describedShell(process.env));
      return {
        name,
        description: bashDescription(facts),
        input_schema: bashInputSchema(facts),
      };
    }
    return {
      name,
      description:
        name === "NotebookEdit"
          ? NOTEBOOK_EDIT_DESCRIPTION
          : name === "Grep"
            ? "Regex search using standalone rg. Defaults to files_with_matches; also content/count. Supports -i, -n and pagination. Searches bounded file prefixes; no multiline/context/glob/type filters."
            : name === "Read"
              ? "Read UTF-8 or BOM-marked UTF-16LE regular text. Whole-file byte limit 262144; default token limit 25000, with partial pages on whole-read token overflow. Optional allow_large uses available context room shared by this reply's large reads. Numbered lines; offset defaults to 1 (0 labels the first line 0), optional positive limit scans that range. No media or PDF pages."
              : name === "Write" || name === "Edit"
                ? `${name} workspace files, preserving existing encoding and BOM. Existing files require a complete, untruncated Read first; reread after external changes.${name === "Edit" ? " Empty old_string creates a file or replaces whitespace-only content. Literal matching first, then curly-quote matching." : ""}`
                : `${name} workspace files. Glob supports *, ** and ?.`,
      input_schema: {
        ...z.toJSONSchema(schemas[name], { io: "input" }),
        type: "object",
      },
    };
  });
}

/** The local file call has passed input/hook/permission guards, but filesystem work may still fail. */
export interface FileToolCallContext {
  name: "Read" | "Write" | "Edit";
  path: string;
  signal: AbortSignal;
}

/** Actual port short-circuit evidence. This is never a native permissionDecision. */
export interface PortToolPermissionTrace {
  tool: ToolName;
  mode: PermissionMode;
  branch:
    | "plan"
    | "memory"
    | "hook"
    | "scoped"
    | "compatibility"
    | "bash"
    | "readonly"
    | "whole"
    | "bypass"
    | "acceptEdits"
    | "approval";
  readonly: boolean;
  asks: boolean;
  wholeToolAsk?: PolicyRuleMatch;
  hookPermission?: PreToolHookResult["permission"];
  fileCandidates?: FilePermissionSessionResult & {
    compatibilityAllow?: PolicyRuleMatch;
  };
  bashCandidates?: BashPermissionSessionResult;
  planFile: boolean;
  admittedAgentMemory?: boolean;
  safetyAsk?: boolean;
  matchedRule?: PolicyRuleMatch;
  approval?: { approved: true; description: string };
}
export interface TextReadRawResult {
  type: "text";
  file: {
    filePath: string;
    content: string;
    numLines: number;
    startLine: number;
    totalLines: number;
  };
}
export interface TextReadResultCapture {
  originalCall: Readonly<ToolUse>;
  effectiveCall: Readonly<ToolUse>;
  canonicalPath: string;
  /** Actual port I/O DTO, independent of whether hookResponse is enabled. */
  rawResult: TextReadRawResult;
  selection: Readonly<TextSelection>;
  render: {
    content: string;
    baseline: string;
    complete: boolean;
    projectionChanged: boolean;
  };
  permissionTrace: Readonly<PortToolPermissionTrace>;
  coreResult: Readonly<ToolResult>;
  finalResult: Readonly<ToolResult>;
  /** Strict ordinary text adapter only; actual native decision mapping is separate. */
  nativeCompatibility:
    | { status: "supported" }
    | { status: "unsupported"; reasons: readonly string[] };
}
/** A local recording failure must not become tool feedback or invoke failure hooks. */
export class TextReadCaptureError extends Error {
  constructor(cause: unknown) {
    super("Text Read result capture failed", { cause });
    this.name = "TextReadCaptureError";
  }
}
function readCaptureSnapshot<T>(value: T): T {
  try {
    const copy = structuredClone(value);
    captureNativePersistenceJson(copy);
    const pending: object[] =
      copy !== null && typeof copy === "object" ? [copy] : [];
    for (const object of pending) {
      const children: unknown[] = Object.values(object);
      for (const child of children)
        if (child !== null && typeof child === "object") pending.push(child);
      Object.freeze(object);
    }
    return copy;
  } catch (error) {
    throw new TextReadCaptureError(error);
  }
}

export function createTools(options: {
  cwd: string;
  mode: PermissionMode;
  policy?: ToolPolicy;
  readState?: ReadState;
  restorationExcludedPaths?: string[];
  readTokenCounter?: FileTokenCounter;
  fileReadMaxTokens?: number;
  sensitiveWritePaths?: readonly string[];
  hooks?: ToolHookRuntime;
  onFileToolCall?: (context: FileToolCallContext) => void | Promise<void>;
  onTextReadResult?: (input: TextReadResultCapture) => void | Promise<void>;
  extraPathAdmission?: (request: {
    operation: string;
    requestedPath: string;
    signal?: AbortSignal;
  }) => Promise<string | undefined>;
  planWriteEligibility?: (request: {
    operation: string;
    requestedPath: string;
    canonicalPath: string;
    signal?: AbortSignal;
  }) => Promise<boolean>;
  /** Source memory candidate, after actual tool/deny/ask/mode/baseline guards. */
  memoryFileAllowance?: (request: {
    operation: "Read" | "Write" | "Edit";
    requestedPath: string;
    canonicalPath: string;
    signal: AbortSignal;
  }) => Promise<boolean>;
  /** Source stampNewMemoryContent: rewrite auto-memory .md bodies before Write and Edit. */
  rewriteMemoryContent?: (request: {
    path: string;
    content: string;
    previous: string | null;
  }) => string;
  filePermissionCandidates?: (request: {
    operation: "Read" | "Write" | "Edit";
    requestedPath: string;
    canonicalPath: string;
    signal: AbortSignal;
  }) =>
    | (FilePermissionSessionResult & {
        compatibilityAllow?: import("./tool-policy.js").PolicyRuleMatch;
      })
    | undefined;
  bashPermissionCandidates?: (request: {
    command: string;
    signal: AbortSignal;
  }) => BashPermissionSessionResult | undefined;
  approve: (
    description: string,
    request: ToolApprovalRequest,
  ) => Promise<ToolApprovalAnswer>;
  /** The session's shell; a standalone executor gets its own. */
  shell?: ShellHost;
}): ToolExecutor {
  const readState = options.readState ?? new ReadState();
  const shell = options.shell ?? createShellHost({ startCwd: options.cwd });
  let readContext: ReadToolContext | undefined;
  const readMaxTokens = options.fileReadMaxTokens ?? fileReadTokenLimit();
  if (!Number.isFinite(readMaxTokens) || readMaxTokens <= 0)
    throw new Error("File Read token limit must be positive and finite");
  const policy = toolPolicySchema.parse(options.policy ?? {});
  for (const [behavior, rules] of [
    ["allow", policy.allowedTools],
    ["deny", policy.disallowedTools],
    ["ask", policy.askedTools ?? []],
  ] as const) {
    for (const rule of rules) requireScopedHost(rule, behavior);
  }
  for (const rule of policy.sourcedRules ?? [])
    requireScopedHost(rule.rule, rule.behavior);
  function requireScopedHost(rule: string, behavior: string) {
    const parsed = parseNativePermissionRule(rule);
    if (
      parsed.kind === "malformed" ||
      !rule.includes("(") ||
      (parsed.kind !== "call" &&
        (behavior !== "allow" || parsed.toolName === "Bash"))
    )
      return;
    if (
      ["Read", "Write", "Edit"].includes(parsed.toolName) &&
      !options.filePermissionCandidates
    )
      throw new Error(
        "Scoped file permission rules require the session path host",
      );
    if (parsed.toolName === "Bash" && !options.bashPermissionCandidates)
      throw new Error(
        "Scoped Bash permission rules require the session command host",
      );
  }
  const available = (name: ToolName) =>
    (policy.tools === undefined || policy.tools.includes(name)) &&
    matchingToolRule(policy, "deny", name) === undefined;
  let rootPromise: Promise<string> | undefined;
  const workspaceRoot = () => (rootPromise ??= realpath(options.cwd));
  async function safePath(
    input: string,
    operation?: ToolName,
    signal?: AbortSignal,
  ): Promise<string> {
    const root = await workspaceRoot();
    const target = path.resolve(root, input);
    const check = (candidate: string) => {
      const relative = path.relative(root, candidate);
      if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        throw new ToolPermissionDenied("Path escapes workspace root");
      if (relative.split(path.sep).some((part) => ignored.has(part)))
        throw new ToolPermissionDenied("Path is excluded");
    };
    try {
      check(target);
      let existing = target;
      const missing: string[] = [];
      for (;;) {
        try {
          const resolved = await realpath(existing);
          check(resolved);
          const result = path.join(resolved, ...missing.reverse());
          check(result);
          return result;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "ENOENT"
          )
            throw error;
          if (existing === root) throw error;
          missing.push(path.basename(existing));
          existing = path.dirname(existing);
        }
      }
    } catch (error) {
      if (
        !(error instanceof ToolPermissionDenied) ||
        error.message !== "Path escapes workspace root" ||
        !operation ||
        !options.extraPathAdmission
      )
        throw error;
      const admitted = await options.extraPathAdmission({
        operation,
        requestedPath: target,
        ...(signal ? { signal } : {}),
      });
      signal?.throwIfAborted();
      if (admitted === undefined || !path.isAbsolute(admitted)) throw error;
      return path.resolve(admitted);
    }
  }
  async function refuseSymlink(input: string): Promise<void> {
    const lexical = path.resolve(await workspaceRoot(), input);
    try {
      if ((await lstat(lexical)).isSymbolicLink())
        throw new Error("Refusing to write through a symlink");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }
  }
  async function readBytes(
    file: string,
    signal: AbortSignal,
    maximum = MAX_BYTES,
  ): Promise<{ bytes: Buffer; mtimeMs: number; truncated: boolean }> {
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Not a regular file");
      const buffer = Buffer.alloc(maximum + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        signal.throwIfAborted();
        const next = await handle.read(
          buffer,
          bytesRead,
          buffer.length - bytesRead,
          bytesRead,
        );
        if (next.bytesRead === 0) break;
        bytesRead += next.bytesRead;
      }
      signal.throwIfAborted();
      return {
        bytes: buffer.subarray(0, bytesRead),
        mtimeMs: info.mtimeMs,
        truncated: info.size > maximum || bytesRead > maximum,
      };
    } finally {
      await handle.close();
    }
  }
  async function files(start: string, signal: AbortSignal): Promise<string[]> {
    const found: string[] = [];
    let visited = 0;
    async function walk(dir: string, depth: number): Promise<void> {
      signal.throwIfAborted();
      if (depth > 64) throw new Error("Traversal depth limit exceeded");
      const entries = await opendir(dir);
      for await (const entry of entries) {
        signal.throwIfAborted();
        if (++visited > MAX_ENTRIES)
          throw new Error("Traversal entry limit exceeded");
        if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
        const file = await safePath(path.join(dir, entry.name));
        if (entry.isDirectory()) await walk(file, depth + 1);
        else if (entry.isFile()) found.push(file);
      }
    }
    if ((await stat(start)).isFile()) return [start];
    await walk(start, 0);
    return found;
  }
  function recheck(
    input: string,
    file: string,
    expected: Buffer | null,
    signal: AbortSignal,
    operation: "Write" | "Edit",
  ): () => Promise<void> {
    return async () => {
      signal.throwIfAborted();
      if ((await safePath(input, operation, signal)) !== file)
        throw new Error("File path changed before write; Read it again");
      await refuseSymlink(input);
      const current = await readFileSnapshot(file, signal, { expected });
      if (current === null && expected !== null) {
        throw new Error(
          "File content changed before write; Read it again before retrying",
        );
      }
      signal.throwIfAborted();
    };
  }
  async function permit(
    name: ToolName,
    description: string,
    signal: AbortSignal,
    fileContext?: { canonical: string; input: string },
    hookPermission?: PreToolHookResult["permission"],
    permissionInput?: unknown,
  ): Promise<PortToolPermissionTrace> {
    const readonly = name === "Read" || name === "Glob" || name === "Grep";
    const denied = matchingToolRule(policy, "deny", name, {
      input: permissionInput,
    });
    if (denied)
      throw new ToolPermissionDenied(
        `Permission rule denies ${name}: ${denied.rule}`,
      );
    const wholeToolAsk = matchingToolRule(policy, "ask", name, {
      input: permissionInput,
    });
    let asks = wholeToolAsk !== undefined || hookPermission === "ask";
    const root = fileContext === undefined ? undefined : await workspaceRoot();
    // Edit file rules govern every built-in file-editing tool, NotebookEdit included.
    const fileOperation = name === "NotebookEdit" ? "Edit" : name;
    const fileRules =
      fileContext !== undefined &&
      root !== undefined &&
      (fileOperation === "Read" ||
        fileOperation === "Write" ||
        fileOperation === "Edit")
        ? options.filePermissionCandidates?.({
            operation: fileOperation,
            requestedPath: path.resolve(root, fileContext.input),
            canonicalPath: fileContext.canonical,
            signal,
          })
        : undefined;
    if (fileRules?.deny)
      throw new ToolPermissionDenied(
        `File permission rule denies ${name}: ${fileRules.deny.rule}`,
      );
    if (fileRules?.status === "unsupported")
      throw new ToolPermissionDenied(
        `File permission rules could not be evaluated: ${fileRules.unsupported.join("; ")}`,
      );
    asks ||= fileRules?.ask !== undefined;
    const command =
      name === "Bash" &&
      typeof permissionInput === "object" &&
      permissionInput !== null &&
      "command" in permissionInput &&
      typeof permissionInput.command === "string"
        ? permissionInput.command
        : undefined;
    const bashRules =
      command === undefined
        ? undefined
        : options.bashPermissionCandidates?.({ command, signal });
    let bashAllow = false;
    if (bashRules) {
      if (bashRules.status === "unsupported")
        throw new ToolPermissionDenied(
          "Command permission rules could not be evaluated for this shell form",
        );
      if (bashRules.exact.deny)
        throw new ToolPermissionDenied(
          `Command permission rule denies Bash: ${bashRules.exact.deny.rule}`,
        );
      if (bashRules.exact.ask) asks = true;
      else if (bashRules.prefix.deny)
        throw new ToolPermissionDenied(
          `Command permission rule denies Bash: ${bashRules.prefix.deny.rule}`,
        );
      else if (bashRules.prefix.ask) asks = true;
      else
        bashAllow =
          bashRules.exact.allow?.resolved === true ||
          bashRules.prefix.allow?.resolved === true;
    }
    const planFile =
      !readonly &&
      fileContext !== undefined &&
      options.planWriteEligibility !== undefined &&
      (await options.planWriteEligibility({
        operation: name,
        requestedPath: path.resolve(await workspaceRoot(), fileContext.input),
        canonicalPath: fileContext.canonical,
        signal,
      }));
    let admittedAgentMemory: boolean | undefined;
    let safetyAsk: boolean | undefined;
    const trace = (
      branch: PortToolPermissionTrace["branch"],
      extra: Pick<PortToolPermissionTrace, "matchedRule" | "approval"> = {},
    ): PortToolPermissionTrace => {
      const value: PortToolPermissionTrace = {
        tool: name,
        mode: options.mode,
        branch,
        readonly,
        asks,
        planFile: Boolean(planFile),
        ...(wholeToolAsk === undefined ? {} : { wholeToolAsk }),
        ...(hookPermission === undefined ? {} : { hookPermission }),
        ...(fileRules === undefined ? {} : { fileCandidates: fileRules }),
        ...(bashRules === undefined ? {} : { bashCandidates: bashRules }),
        ...(admittedAgentMemory === undefined ? {} : { admittedAgentMemory }),
        ...(safetyAsk === undefined ? {} : { safetyAsk }),
        ...extra,
      };
      return options.onTextReadResult && name === "Read"
        ? readCaptureSnapshot(value)
        : value;
    };
    signal.throwIfAborted();
    // The designated session plan bypasses the ordinary plan/sensitive hold.
    // Explicit deny/ask and full validation retain their earlier authority.
    if (options.mode === "plan" && !readonly && !planFile)
      throw new ToolPermissionDenied("Plan mode is read only");
    if (planFile && !asks) return trace("plan");
    admittedAgentMemory =
      !asks &&
      fileContext !== undefined &&
      root !== undefined &&
      (fileOperation === "Read" ||
        fileOperation === "Write" ||
        fileOperation === "Edit") &&
      (await options.memoryFileAllowance?.({
        operation: fileOperation,
        requestedPath: path.resolve(root, fileContext.input),
        canonicalPath: fileContext.canonical,
        signal,
      })) === true;
    signal.throwIfAborted();
    const sensitive =
      readonly || fileContext === undefined || root === undefined
        ? undefined
        : (sensitiveWriteReason(
            fileContext.input,
            root,
            options.sensitiveWritePaths,
            { admittedAgentMemory },
          ) ??
          sensitiveWriteReason(
            fileContext.canonical,
            root,
            options.sensitiveWritePaths,
            { admittedAgentMemory },
          ));
    safetyAsk =
      !planFile &&
      sensitive !== undefined &&
      options.mode !== "bypassPermissions";
    if (!asks && !safetyAsk) {
      // Keep the original OR's exact short-circuit order. In particular a Read
      // reaches readonly before whole-tool, bypass or acceptEdits checks.
      if (hookPermission === "allow") return trace("hook");
      if (admittedAgentMemory) return trace("memory");
      const scopedAllow = fileRules?.allow;
      if (scopedAllow !== undefined)
        return trace("scoped", { matchedRule: scopedAllow });
      const compatibilityAllow = fileRules?.compatibilityAllow;
      if (compatibilityAllow !== undefined)
        return trace("compatibility", { matchedRule: compatibilityAllow });
      if (bashAllow) return trace("bash");
      if (readonly) return trace("readonly");
      const whole = matchingToolRule(policy, "allow", name);
      if (whole !== undefined) return trace("whole", { matchedRule: whole });
      if (options.mode === "bypassPermissions") return trace("bypass");
      if (options.mode === "acceptEdits" && name !== "Bash")
        return trace("acceptEdits");
    }
    let approved: ToolApprovalAnswer;
    const approvalDescription = safetyAsk
      ? `${sensitive}. Once approval is required.\n${description}`
      : description;
    // Approval is an external callback: retain the actual ask/candidate evidence
    // before it can change the host's live policy/candidate objects.
    const approvalTrace = trace("approval");
    try {
      approved = await options.approve(approvalDescription, {
        tool: name,
        ...(fileContext === undefined ? {} : { path: fileContext.canonical }),
        ...(safetyAsk ? { sensitive: true } : {}),
      });
    } catch (error) {
      throw new ToolPermissionDenied(
        error instanceof Error
          ? error.message
          : "Permission approval did not complete",
        "pre-ask",
      );
    }
    // A refusal that also ends the turn keeps its own message as the result.
    if (typeof approved === "object")
      throw new ToolPermissionDenied(approved.message, "pre-ask");
    if (signal.aborted)
      throw new ToolPermissionDenied("Permission approval aborted");
    if (!approved)
      throw new ToolPermissionDenied("Permission denied", "pre-ask");
    const accepted: PortToolPermissionTrace = {
      ...approvalTrace,
      approval: { approved: true, description: approvalDescription },
    };
    return options.onTextReadResult && name === "Read"
      ? readCaptureSnapshot(accepted)
      : accepted;
  }
  async function checkSensitiveReadPrecondition(
    file: string,
    input: string,
  ): Promise<void> {
    const root = await workspaceRoot();
    if (
      sensitiveWriteReason(input, root, options.sensitiveWritePaths) ===
        undefined &&
      sensitiveWriteReason(file, root, options.sensitiveWritePaths) ===
        undefined
    )
      return;
    try {
      if ((await stat(file)).isFile()) readState.requireComplete(file);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
  }
  function protectReadDeniedFile(operation: "written" | "edited"): void {
    if (inheritedReadDeny(policy))
      throw new ToolPermissionDenied(
        `File is covered by a Read deny rule and cannot be ${operation}`,
      );
  }
  /** NotebookEdit's validateInput order: extension, insert type, prior Read, existence, cell. */
  async function notebookSnapshot(
    file: string,
    input: z.infer<typeof notebookEditInputSchema>,
    signal: AbortSignal,
  ): Promise<{ bytes: Buffer; text: string }> {
    if (path.extname(file) !== ".ipynb")
      throw new ToolInputRejected(
        "File must be a Jupyter notebook (.ipynb file). For editing other file types, use the FileEdit tool.",
      );
    if (input.edit_mode === "insert" && !input.cell_type)
      throw new ToolInputRejected(
        "Cell type is required when using edit_mode=insert.",
      );
    if (!readState.has(file))
      throw new ToolInputRejected(
        "File has not been read yet. Read it first before writing to it.",
      );
    await refuseSymlink(file);
    const bytes = await readFileSnapshot(file, signal, {
      maximum: MAX_NOTEBOOK_BYTES,
      requireRead: () => readState.requireComplete(file),
    });
    if (bytes === null)
      throw new ToolInputRejected("Notebook file does not exist.");
    readState.assertCurrent(file, bytes);
    const text = decodeTextFile(bytes).text.replace(/^\uFEFF/, "");
    applyNotebookEdit(text, input, file);
    return { bytes, text };
  }
  async function validateInput(
    name: ToolName,
    value: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const input =
      name === "Bash"
        ? parseBashInput(value, shell.facts().backgroundDisabled)
        : schemas[name].parse(value);
    if (name === "Write" || name === "Edit") {
      protectReadDeniedFile(name === "Write" ? "written" : "edited");
      const mutation =
        name === "Write"
          ? schemas.Write.parse(input)
          : schemas.Edit.parse(input);
      const file = await safePath(mutation.file_path, name, signal);
      await refuseSymlink(mutation.file_path);
      const previous = await readFileSnapshot(file, signal, {
        ...(name === "Edit" ? { maximum: MAX_EDIT_BYTES } : {}),
        requireRead: () => readState.requireComplete(file),
      });
      if (previous !== null) readState.assertCurrent(file, previous);
      if (name === "Edit") {
        const edit = schemas.Edit.parse(input);
        if (previous === null && edit.old_string !== "")
          throw new Error(
            "Edit requires an existing file unless old_string is empty",
          );
        applyEdit(previous === null ? "" : decodeTextFile(previous).text, edit);
      }
    } else if (name === "NotebookEdit") {
      protectReadDeniedFile("edited");
      const edit = schemas.NotebookEdit.parse(input);
      const file = await safePath(edit.notebook_path, name, signal);
      await notebookSnapshot(file, edit, signal);
    } else if (name === "Read")
      await safePath(schemas.Read.parse(input).file_path, name, signal);
    else if (name === "Glob")
      await safePath(schemas.Glob.parse(input).path, name, signal);
    else if (name === "Grep")
      await safePath(schemas.Grep.parse(input).path, name, signal);
    signal.throwIfAborted();
    // Execution defaults are applied when the call runs. Hook payloads retain
    // omission of these optional inputs, as observed in the original fixture.
    const normalized: Record<string, unknown> = { ...input };
    if (typeof value === "object" && value !== null) {
      if (name === "Read" && !Object.hasOwn(value, "offset"))
        delete normalized.offset;
      if (name === "Bash" && !Object.hasOwn(value, "timeout"))
        delete normalized.timeout;
    }
    if (name === "NotebookEdit")
      return {
        ...normalized,
        notebook_path: path.resolve(
          await workspaceRoot(),
          schemas.NotebookEdit.parse(input).notebook_path,
        ),
      };
    if (name === "Write" || name === "Edit" || name === "Read") {
      return {
        ...normalized,
        file_path: path.resolve(
          await workspaceRoot(),
          schemas[name].parse(input).file_path,
        ),
      };
    }
    return normalized;
  }
  return {
    get definitions() {
      return toolDefinitions(toolNameSchema.options.filter(available), shell);
    },
    setReadContext(context) {
      readContext = context;
    },
    async prepareCompaction(input) {
      const cwd = await workspaceRoot();
      // CLAUDE.md is the instruction file currently loaded by tau's prompt builder.
      const excludedPaths = [
        path.join(cwd, "CLAUDE.md"),
        ...(options.restorationExcludedPaths ?? []),
      ];
      try {
        excludedPaths.push(await safePath("CLAUDE.md"));
      } catch {
        /* Missing/unavailable instructions. */
      }
      return prepareFileRestoration({
        ...input,
        cwd,
        state: readState,
        excludedPaths,
        read: async (file, signal) => {
          if (!available("Read"))
            throw new Error("Read disabled or denied by policy");
          const resolved = await safePath(file, "Read", signal);
          await permit(
            "Read",
            `Read ${resolved} to restore file context`,
            signal,
            { canonical: resolved, input: file },
            undefined,
            { file_path: file },
          );
          if (resolved !== file)
            throw new Error("File path changed since Read");
          return readBytes(resolved, signal, FILE_READ_BYTES);
        },
      });
    },
    async execute(call, signal) {
      let pre: PreToolHookResult | undefined;
      let effectiveCall: ToolUse = call;
      let inCall = false;
      let readCaptureStarted = false;
      let originalReadCall: ToolUse | undefined;
      try {
        signal.throwIfAborted();
        const name = toolNameSchema.parse(call.name);
        if (!available(name))
          throw new ToolPermissionDenied(
            `Tool disabled or denied by policy: ${name}`,
          );
        const unparsed = unparsedToolInput(call.input);
        if (unparsed)
          throw new ToolInputRejected(
            `input JSON failed to parse — ${unparsed.len} bytes`,
          );
        const validate = async (input: unknown) => {
          try {
            return await validateInput(name, input, signal);
          } catch (error) {
            signal.throwIfAborted();
            if (
              error instanceof ToolPermissionDenied ||
              error instanceof ToolInputRejected ||
              error instanceof z.ZodError
            )
              throw error;
            throw new ToolInputRejected(
              error instanceof Error
                ? error.message
                : "Tool input validation failed",
            );
          }
        };
        effectiveCall = { ...call, input: await validate(call.input) };
        if (name === "Read" && options.onTextReadResult)
          originalReadCall = readCaptureSnapshot(call);
        if (options.hooks) {
          pre = await options.hooks.before(effectiveCall, signal, validate);
          signal.throwIfAborted();
          if (pre.preventContinuation)
            return appendPreHookContext(
              {
                type: "tool_result",
                tool_use_id: call.id,
                content: pre.stopReason ?? "Tool call stopped by hook",
                is_error: true,
              },
              pre,
              effectiveCall,
              pre.stopReason ?? "Continuation stopped by hook",
            );
          if (pre.permission === "deny" || pre.permission === "defer")
            throw new ToolPermissionDenied(
              pre.reason ??
                (pre.permission === "defer"
                  ? "Hook requested deferred approval; this runner cannot resume deferred tool calls"
                  : "Tool denied by hook"),
            );
          if (pre.updatedInput !== undefined)
            effectiveCall = {
              ...call,
              input: await validate(pre.updatedInput),
            };
        }
        const finish = async (result: ToolResult): Promise<ToolResult> => {
          const annotated = appendPreHookContext(
            {
              ...result,
              ...(pre?.updatedInput === undefined
                ? {}
                : { effectiveToolInput: effectiveCall.input }),
            },
            pre,
            effectiveCall,
          );
          return options.hooks
            ? options.hooks.after(effectiveCall, annotated, signal)
            : annotated;
        };
        const responsePath = (effectivePath: string): string => {
          const original =
            call.input !== null &&
            typeof call.input === "object" &&
            "file_path" in call.input &&
            typeof call.input.file_path === "string"
              ? call.input.file_path
              : effectivePath;
          return path.resolve(options.cwd, original) === effectivePath
            ? original
            : effectivePath;
        };
        let hookResponse: unknown;
        let content: string;
        switch (name) {
          case "Read": {
            const input = schemas.Read.parse(effectiveCall.input);
            const file = await safePath(input.file_path, "Read", signal);
            const permissionTrace = await permit(
              name,
              `Read ${file}`,
              signal,
              { canonical: file, input: input.file_path },
              pre?.permission,
              effectiveCall.input,
            );
            inCall = true;
            await options.onFileToolCall?.({ name, path: file, signal });
            signal.throwIfAborted();
            if (path.extname(file) === ".ipynb") {
              const info = await stat(file);
              if (info.size > MAX_NOTEBOOK_BYTES)
                throw new Error(
                  `Notebook file exceeds the maximum size this tool can read (${MAX_NOTEBOOK_BYTES} bytes).`,
                );
              const bytes = await readFileSnapshot(file, signal);
              if (bytes === null) throw new Error("File does not exist.");
              const blocks = renderNotebook(
                decodeTextFile(bytes).text.replace(/^\uFEFF/, ""),
              );
              readState.remember(file, bytes, info.mtimeMs);
              inCall = false;
              return await finish({
                type: "tool_result",
                tool_use_id: call.id,
                content: blocks
                  .flatMap((block) =>
                    block.type === "text" ? [block.text] : [],
                  )
                  .join("\n"),
                apiContent: blocks,
              });
            }
            const context = readContext,
              initial = input.allow_large
                ? readAllowance(context, readMaxTokens, FILE_READ_BYTES)
                : {};
            try {
              const handle = await open(
                file,
                constants.O_RDONLY |
                  constants.O_NOFOLLOW |
                  constants.O_NONBLOCK,
              );
              const selected = await (async () => {
                try {
                  return await selectTextFile(
                    handle,
                    input,
                    signal,
                    readMaxTokens,
                    initial.raised?.maxSizeBytes,
                  );
                } finally {
                  await handle.close();
                }
              })();
              const view = await renderSelectedText(
                selected,
                input,
                file,
                readMaxTokens,
                signal,
                context?.countTokens ?? options.readTokenCounter,
                { initial, context },
              );
              if (view.complete)
                readState.remember(
                  file,
                  Buffer.from(view.baseline),
                  selected.mtimeMs,
                );
              else readState.rememberPartial(file, selected.mtimeMs);
              inCall = false;
              const rawResult: TextReadRawResult = {
                type: "text",
                file: {
                  filePath: responsePath(input.file_path),
                  content: view.baseline,
                  numLines:
                    view.baseline === selected.text
                      ? selected.lineCount
                      : selected.lineCount === 0
                        ? 0
                        : view.baseline.split("\n").length,
                  startLine: input.offset,
                  totalLines: selected.totalLines,
                },
              };
              const core: ToolResult = {
                type: "tool_result",
                tool_use_id: call.id,
                content: view.content,
                ...(options.hooks ? { hookResponse: rawResult } : {}),
              };
              if (!options.onTextReadResult) return await finish(core);
              // Capture actual I/O and core state before Post can mutate its raw
              // hookResponse; the journal receives the accepted final result too.
              const io = readCaptureSnapshot({
                originalCall: originalReadCall ?? call,
                effectiveCall,
                canonicalPath: file,
                rawResult,
                selection: selected,
                render: {
                  ...view,
                  projectionChanged: view.baseline !== selected.text,
                },
                permissionTrace,
                coreResult: core,
              });
              const finalResult = await finish(core);
              readCaptureStarted = true;
              signal.throwIfAborted();
              const reasons: string[] = [];
              if (
                io.render.projectionChanged ||
                (input.offset <= 1 &&
                  input.limit === undefined &&
                  !view.complete)
              )
                reasons.push(
                  "Whole-file projection does not expose a confirmed native unpaginated result; actual native clipping/pagination metadata is required",
                );
              if (pre?.updatedInput !== undefined)
                reasons.push(
                  "Pre-hook input rewrite observed; native restored call-input provenance requires its explicit adapter",
                );
              if (
                finalResult.type !== io.coreResult.type ||
                finalResult.tool_use_id !== io.coreResult.tool_use_id ||
                finalResult.content !== io.coreResult.content ||
                finalResult.is_error !== io.coreResult.is_error ||
                finalResult.hookRewrittenOutput !== undefined ||
                (finalResult.hookResponse !== undefined &&
                  !isDeepStrictEqual(finalResult.hookResponse, io.rawResult))
              )
                reasons.push(
                  "Final Post result differs from the original Read I/O DTO; an accepted native rewrite/result adapter is required",
                );
              const captured: TextReadResultCapture = readCaptureSnapshot({
                ...io,
                finalResult,
                nativeCompatibility: reasons.length
                  ? { status: "unsupported", reasons }
                  : { status: "supported" },
              });
              try {
                await options.onTextReadResult(captured);
                signal.throwIfAborted();
              } catch (error) {
                signal.throwIfAborted();
                throw new TextReadCaptureError(error);
              }
              return finalResult;
            } catch (error) {
              if (
                error instanceof FileReadByteLimit ||
                error instanceof FileReadTokenLimit
              )
                throw new Error(
                  error.message +
                    largeReadHint(
                      context,
                      input.allow_large === true,
                      readMaxTokens,
                      error instanceof FileReadByteLimit
                        ? { bytes: error.bytes }
                        : { tokens: error.tokens },
                    ),
                );
              throw error;
            }
          }
          case "Write": {
            protectReadDeniedFile("written");
            const input = schemas.Write.parse(effectiveCall.input);
            let file = await safePath(input.file_path, "Write", signal);
            await checkSensitiveReadPrecondition(file, input.file_path);
            await permit(
              name,
              `Write ${file}\nProposed content:\n${bounded(input.content)}`,
              signal,
              { canonical: file, input: input.file_path },
              pre?.permission,
              effectiveCall.input,
            );
            inCall = true;
            file = await safePath(input.file_path, "Write", signal);
            await refuseSymlink(input.file_path);
            await options.onFileToolCall?.({ name, path: file, signal });
            signal.throwIfAborted();
            await mkdir(path.dirname(file), { recursive: true });
            file = await safePath(input.file_path, "Write", signal);
            await refuseSymlink(input.file_path);
            const previous = await readFileSnapshot(file, signal, {
              requireRead: () => readState.requireComplete(file),
            });
            if (previous !== null) readState.assertCurrent(file, previous);
            const previousText =
              previous === null ? null : decodeTextFile(previous).text;
            const writtenContent =
              options.rewriteMemoryContent?.({
                path: file,
                content: input.content,
                previous: previousText,
              }) ?? input.content;
            const updated = encodeTextFile(
              writtenContent,
              previous === null ? undefined : decodeTextFile(previous),
            );
            const mtimeMs = await writeAtomic(
              file,
              updated,
              recheck(input.file_path, file, previous, signal, "Write"),
            );
            readState.remember(file, updated, mtimeMs);
            if (options.hooks) {
              const originalFile = previousText;
              hookResponse = {
                type: previous === null ? "create" : "update",
                filePath: responsePath(input.file_path),
                content: writtenContent,
                structuredPatch:
                  originalFile === null
                    ? []
                    : textPatch(originalFile, writtenContent),
                originalFile,
                userModified: false,
              };
            }
            content = "File written";
            break;
          }
          case "Edit": {
            protectReadDeniedFile("edited");
            const input = schemas.Edit.parse(effectiveCall.input);
            let file = await safePath(input.file_path, "Edit", signal);
            await checkSensitiveReadPrecondition(file, input.file_path);
            await permit(
              name,
              `Edit ${file}\n${bounded(`Replace:\n${input.old_string}\nWith:\n${input.new_string}`)}`,
              signal,
              { canonical: file, input: input.file_path },
              pre?.permission,
              effectiveCall.input,
            );
            inCall = true;
            file = await safePath(input.file_path, "Edit", signal);
            await refuseSymlink(input.file_path);
            await options.onFileToolCall?.({ name, path: file, signal });
            signal.throwIfAborted();
            const previous = await readFileSnapshot(file, signal, {
              maximum: MAX_EDIT_BYTES,
              requireRead: () => readState.requireComplete(file),
            });
            if (previous === null && input.old_string !== "")
              throw new Error(
                "Edit requires an existing file unless old_string is empty",
              );
            if (previous !== null) readState.assertCurrent(file, previous);
            const original =
              previous === null ? undefined : decodeTextFile(previous);
            const edited = applyEdit(original?.text ?? "", input);
            const writtenContent =
              options.rewriteMemoryContent?.({
                path: file,
                content: edited,
                previous: original?.text ?? null,
              }) ?? edited;
            const updated = encodeTextFile(writtenContent, original);
            await mkdir(path.dirname(file), { recursive: true });
            const mtimeMs = await writeAtomic(
              file,
              updated,
              recheck(input.file_path, file, previous, signal, "Edit"),
            );
            readState.remember(file, updated, mtimeMs);
            if (options.hooks)
              hookResponse = {
                filePath: responsePath(input.file_path),
                oldString: input.old_string,
                newString: input.new_string,
                originalFile: original?.text ?? "",
                structuredPatch: textPatch(
                  original?.text ?? "",
                  decodeTextFile(updated).text,
                ),
                userModified: false,
                replaceAll: input.replace_all,
              };
            content = "File edited";
            break;
          }
          case "NotebookEdit": {
            protectReadDeniedFile("edited");
            const input = schemas.NotebookEdit.parse(effectiveCall.input);
            const file = await safePath(input.notebook_path, name, signal);
            await checkSensitiveReadPrecondition(file, input.notebook_path);
            await permit(
              name,
              `NotebookEdit ${file}\n${bounded(`${input.edit_mode ?? "replace"} cell ${input.cell_id ?? "(start)"}:\n${input.new_source}`)}`,
              signal,
              { canonical: file, input: input.notebook_path },
              pre?.permission,
              effectiveCall.input,
            );
            inCall = true;
            await options.onFileToolCall?.({
              name: "Edit",
              path: file,
              signal,
            });
            signal.throwIfAborted();
            const previous = await notebookSnapshot(file, input, signal);
            const edit = applyNotebookEdit(previous.text, input, file);
            const updated = encodeTextFile(
              edit.updated,
              decodeTextFile(previous.bytes),
            );
            if (updated.length > MAX_NOTEBOOK_BYTES)
              throw new Error(
                `Edit rejected: the updated notebook would exceed the maximum size this tool can read (${MAX_NOTEBOOK_BYTES} bytes). The file was left unchanged.`,
              );
            const mtimeMs = await writeAtomic(
              file,
              updated,
              recheck(
                input.notebook_path,
                file,
                previous.bytes,
                signal,
                "Edit",
              ),
            );
            readState.remember(file, updated, mtimeMs);
            if (options.hooks) hookResponse = edit.hookResponse;
            content = edit.message;
            break;
          }
          case "Glob": {
            const input = schemas.Glob.parse(effectiveCall.input);
            const start = await safePath(input.path);
            await permit(
              name,
              `Glob ${input.pattern} in ${start}`,
              signal,
              undefined,
              pre?.permission,
              effectiveCall.input,
            );
            inCall = true;
            if (!(await stat(start)).isDirectory())
              throw new Error("Glob path must be a directory");
            const root = await workspaceRoot();
            const matches: string[] = [];
            const matchesPattern = createGlobMatcher(input.pattern);
            for (const file of await files(start, signal)) {
              signal.throwIfAborted();
              if (
                matchesPattern(
                  path.relative(start, file).split(path.sep).join("/"),
                )
              ) {
                matches.push(
                  path.relative(root, file).split(path.sep).join("/"),
                );
              }
              if (matches.length >= 1000) {
                matches.push("[results truncated]");
                break;
              }
            }
            content = bounded(matches.join("\n"));
            break;
          }
          case "Grep": {
            const input = schemas.Grep.parse(effectiveCall.input);
            const start = await safePath(input.path);
            await permit(
              name,
              `Grep ${input.pattern} in ${start}`,
              signal,
              undefined,
              pre?.permission,
              effectiveCall.input,
            );
            inCall = true;
            const root = await workspaceRoot();
            const directory = (await stat(start)).isDirectory();
            const executable = await findRipgrep();
            const deadline = Date.now() + 20000;
            const search = (text: string) =>
              searchText({
                executable,
                input,
                text,
                signal,
                timeout: deadline - Date.now(),
              });
            await search(""); // Validate regex even when the workspace/filter has no candidates.
            const rows: Array<{ text: string; name: string; mtimeMs: number }> =
              [];
            let retainedBytes = 0;
            let incomplete = false;
            let prefixes = false;
            for (const file of (await files(start, signal)).sort()) {
              signal.throwIfAborted();
              const relative = path
                .relative(root, file)
                .split(path.sep)
                .join("/");
              const { bytes, mtimeMs, truncated } = await readBytes(
                file,
                signal,
              );
              if (truncated) prefixes = true;
              const prefix = bytes.subarray(0, MAX_BYTES);
              if (prefix.includes(0)) continue;
              const result = await search(prefix.toString());
              if (!result.matched) continue;
              let entries: string[];
              switch (input.output_mode) {
                case "files_with_matches":
                  entries = [relative];
                  break;
                case "count": {
                  const count = result.output.trim();
                  if (!/^[1-9]\d*$/.test(count))
                    throw new Error("Invalid Grep count response");
                  entries = [`${relative}:${count}`];
                  break;
                }
                case "content":
                  entries = result.output
                    .replace(/\n$/, "")
                    .split("\n")
                    .map((line) => (directory ? `${relative}:${line}` : line));
                  break;
                default: {
                  const exhaustive: never = input.output_mode;
                  throw new Error(`Unknown Grep mode: ${String(exhaustive)}`);
                }
              }
              for (const text of entries) {
                rows.push({ text, name: relative, mtimeMs });
                retainedBytes += Buffer.byteLength(text);
                if (rows.length >= 20000 || retainedBytes >= 1024 * 1024) {
                  incomplete = true;
                  break;
                }
              }
              if (incomplete) break;
            }
            signal.throwIfAborted();
            if (Date.now() >= deadline) throw new Error("Grep timed out");
            if (input.output_mode === "files_with_matches")
              rows.sort(
                (a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name),
              );
            const end =
              input.head_limit === 0
                ? undefined
                : input.offset + input.head_limit;
            const page = rows.slice(input.offset, end);
            content = page.length
              ? page.map((row) => row.text).join("\n")
              : rows.length
                ? "No entries at this offset"
                : input.output_mode === "files_with_matches"
                  ? "No files found"
                  : "No matches found";
            if (end !== undefined && rows.length > end)
              content += `\n[more results: limit ${input.head_limit}, offset ${input.offset}]`;
            if (prefixes)
              content +=
                "\n[search incomplete: only the first 65536 bytes of each file were searched]";
            if (incomplete)
              content += "\n[search results truncated by resource limit]";
            break;
          }
          case "Bash": {
            const input = shell.parse(effectiveCall.input);
            const refusal = shell.refusal(input);
            if (refusal !== undefined)
              return appendPreHookContext(
                {
                  type: "tool_result",
                  tool_use_id: call.id,
                  content: refusal,
                  is_error: true,
                },
                pre,
                effectiveCall,
              );
            await permit(
              name,
              `Run Bash (shell is NOT sandboxed and can access files outside the workspace): ${input.command}`,
              signal,
              undefined,
              pre?.permission,
              effectiveCall.input,
            );
            inCall = true;
            const outcome = await shell.run(input, {
              toolUseId: call.id,
              signal,
            });
            inCall = false;
            const result = shell.render(outcome);
            const mapped: ToolResult = {
              type: "tool_result",
              tool_use_id: call.id,
              content: result.content,
              ...(result.is_error ? { is_error: true } : {}),
              ...(options.hooks
                ? {
                    hookResponse: {
                      stdout:
                        outcome.kind === "completed" ||
                        outcome.kind === "background"
                          ? outcome.output
                          : "",
                      stderr:
                        outcome.kind === "completed"
                          ? (outcome.cwdNote ?? "")
                          : "",
                      interrupted: false,
                      isImage: false,
                      noOutputExpected: shell.noOutputExpected(input.command),
                      ...(outcome.kind === "background"
                        ? { backgroundTaskId: outcome.taskId }
                        : {}),
                    },
                  }
                : {}),
            };
            // A failed command is a thrown ShellError in the original, so
            // failure hooks run instead of PostToolUse.
            if (result.is_error) {
              const failure = await options.hooks?.failure?.(
                effectiveCall,
                new Error(result.content),
                signal,
              );
              return appendFailureHookContext(
                appendPreHookContext(mapped, pre, effectiveCall),
                failure,
              );
            }
            return await finish(mapped);
          }
          default: {
            const exhaustive: never = name;
            throw new Error(`Unknown tool: ${String(exhaustive)}`);
          }
        }
        inCall = false;
        return await finish({
          type: "tool_result",
          tool_use_id: call.id,
          content: bounded(content),
          ...(hookResponse === undefined ? {} : { hookResponse }),
        });
      } catch (error) {
        if (error instanceof TextReadCaptureError) throw error;
        if (readCaptureStarted) signal.throwIfAborted();
        let failure: ToolFailureHookResult | void = undefined;
        if (inCall && options.hooks?.failure)
          try {
            failure = await options.hooks.failure(effectiveCall, error, signal);
          } catch {
            signal.throwIfAborted();
          }
        return appendFailureHookContext(
          appendPreHookContext(
            {
              type: "tool_result",
              tool_use_id: call.id,
              content: bounded(
                error instanceof Error ? error.message : String(error),
              ),
              is_error: true,
              ...(pre?.updatedInput === undefined
                ? {}
                : { effectiveToolInput: effectiveCall.input }),
              ...permissionDeniedMarkers(error),
              ...(error instanceof ToolInputRejected ||
              error instanceof z.ZodError
                ? { inputRejected: true }
                : {}),
            },
            pre,
            effectiveCall,
          ),
          failure,
        );
      }
    },
  };
}
