/**
 * Workflow (chunk-082xbwcm.js WorkflowTool). Input checks follow the
 * original resolve order. There is no script executor, so a script that
 * passes those checks is refused instead of launched.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { WORKFLOW_DESCRIPTION } from "./eager-catalog-text.js";
import type { GuardedTool } from "./guarded-tool.js";
import type { ToolDefinition } from "./types.js";

export const WORKFLOW_TOOL = "Workflow";
export const WORKFLOW_SEARCH_HINT =
  "orchestrate subagents with deterministic JavaScript workflow";
export const WORKFLOW_REVIEW_PROMPT = "Review dynamic workflow before running";
export const WORKFLOW_NOT_LAUNCHED =
  "Workflow was not launched: this build has no workflow executor.";
const SCRIPT_BYTES = 524288;
const RUN_ID = /^wf_[a-z0-9-]{6,}$/;

export class WorkflowInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowInputError";
  }
}

function hiddenInApproval(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 9 || code === 10) continue;
    if (code < 32 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error))
    return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

const workflowSchema = z
  .object({
    script: z
      .string()
      .max(SCRIPT_BYTES)
      .refine(
        (script) => !hiddenInApproval(script),
        "script contains control characters that would be hidden in the approval dialog",
      )
      .optional()
      .describe(
        "Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` (pure literal, no computed values) followed by the script body using agent()/parallel()/pipeline()/phase().",
      ),
    name: z
      .string()
      .refine(
        (name) => !hiddenInApproval(name) && !/\p{Cf}/u.test(name),
        "contains control or invisible format characters",
      )
      .optional()
      .describe(
        "Name of a predefined workflow (built-in or from .claude/workflows/). Resolves to a self-contained script.",
      ),
    description: z
      .string()
      .optional()
      .describe(
        "Ignored \u2014 set the workflow description in the script's `meta` block.",
      ),
    title: z
      .string()
      .optional()
      .describe(
        "Ignored \u2014 set the workflow title in the script's `meta` block.",
      ),
    args: z
      .unknown()
      .optional()
      .describe(
        "Optional input value exposed to the script as the global `args`, verbatim. Pass arrays/objects as actual JSON values, NOT as a JSON-encoded string \u2014 a stringified list breaks `args.filter`/`args.map` in the script. Use for parameterized named workflows (e.g. a research question).",
      ),
    scriptPath: z
      .string()
      .optional()
      .describe(
        "Path to a workflow script file on disk. Every Workflow invocation persists its script under the session directory and returns the path in the tool result. To iterate, edit that file with Write/Edit and re-invoke Workflow with the same `scriptPath` instead of re-sending the full script. Takes precedence over `script` and `name`.",
      ),
    resumeFromRunId: z
      .string()
      .regex(RUN_ID)
      .optional()
      .describe(
        "Run ID of a prior Workflow invocation to resume from. The cache is positional: agent() calls replay from cache up to the first call that failed, no longer matches the earlier run (edited, added, removed or reordered) or never started in it; that call and every call after it run again, even when their own (prompt, opts) are unchanged. A call a usage limit refused, or one still running when the run stopped, usually runs again without ending reuse: finished calls after it still come from cache. Same-session only. Stop the prior run first (TaskStop) before resuming.",
      ),
  })
  .strict();
export type WorkflowInput = z.infer<typeof workflowSchema>;

async function scriptFileError(path: string): Promise<string | undefined> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? `Workflow script file not found: ${path}`
      : `Failed to read workflow script file ${path}`;
  }
  if (!info.isFile())
    return `Workflow script file ${path} is not a regular file`;
  if (info.size > SCRIPT_BYTES)
    return `Workflow script file ${path} exceeds ${SCRIPT_BYTES} bytes`;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return `Failed to read workflow script file ${path}`;
  }
  if (hiddenInApproval(text))
    return `Workflow script file ${path} contains a control character that an approval prompt cannot show, such as an escape byte or a carriage return that is not part of a CRLF line ending. Remove it from the file and try again.`;
  return undefined;
}

export function workflowDefinition(): ToolDefinition {
  return {
    name: WORKFLOW_TOOL,
    description: WORKFLOW_DESCRIPTION,
    input_schema: {
      ...z.toJSONSchema(workflowSchema, { io: "input" }),
      type: "object",
    },
  };
}

export interface WorkflowSource {
  kind: "inline" | "path" | "named";
  text: string;
  path?: string;
}

export interface WorkflowToolOptions {
  /** Directory holding named `.js` workflows, e.g. `<project>/.claude/workflows`. */
  workflowsDir?: string;
}

/** Pure-literal object after `export const meta =`; computed values are refused. */
function parseMeta(text: string): { name: string } | undefined {
  const match = /export\s+const\s+meta\s*=\s*\{/.exec(text);
  if (!match) return undefined;
  const start = match.index + match[0].length - 1;
  let depth = 0;
  let quote = "";
  let end = -1;
  for (let i = start; i < text.length && end < 0; i++) {
    const ch = text.charAt(i);
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) end = i;
  }
  if (end < 0) return undefined;
  const literal = text.slice(start, end + 1);
  const bare = literal
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
    .replace(/[A-Za-z_$][\w$]*(?=\s*:)/g, "")
    .replace(/\b(?:true|false|null)\b/g, "");
  if (/[A-Za-z_$]|\(|`/.test(bare)) return undefined;
  const field = (key: string): string | undefined =>
    new RegExp(
      `(?:^|[{,\\s])${key}\\s*:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)')`,
    )
      .exec(literal)
      ?.slice(1, 3)
      .find((part) => part !== undefined);
  const name = field("name");
  if (!name || field("description") === undefined) return undefined;
  return { name };
}

/** Named workflows: `*.js` files whose `meta.name` is declared, sorted by name. */
export async function listNamedWorkflows(
  dir: string | undefined,
): Promise<Array<{ name: string; text: string; path: string }>> {
  if (dir === undefined) return [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const found = new Map<string, { name: string; text: string; path: string }>();
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".js")) continue;
    const path = join(dir, entry);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > SCRIPT_BYTES) continue;
      const text = await readFile(path, "utf8");
      const meta = parseMeta(text);
      if (meta) found.set(meta.name, { name: meta.name, text, path });
    } catch {
      continue;
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** scriptPath wins, then name, then inline script (original resolve order). */
export async function resolveWorkflowSource(
  input: WorkflowInput,
  options: WorkflowToolOptions = {},
): Promise<WorkflowSource | { error: string }> {
  if (input.scriptPath !== undefined) {
    const error = await scriptFileError(input.scriptPath);
    if (error) return { error };
    return input.script !== undefined
      ? { kind: "inline", text: input.script, path: input.scriptPath }
      : {
          kind: "path",
          text: await readFile(input.scriptPath, "utf8"),
          path: input.scriptPath,
        };
  }
  if (input.name !== undefined) {
    const all = await listNamedWorkflows(options.workflowsDir);
    const hit = all.find((workflow) => workflow.name === input.name);
    if (!hit) {
      const list = all.map((workflow) => workflow.name).join(", ");
      return {
        error: `Workflow "${input.name}" not found. Available: ${list || "(none)"}`,
      };
    }
    return { kind: "named", text: input.script ?? hit.text, path: hit.path };
  }
  if (input.script !== undefined) return { kind: "inline", text: input.script };
  return { error: "Must provide script, name, or scriptPath" };
}

export function workflowTool(
  options: WorkflowToolOptions = {},
): GuardedTool<WorkflowInput> {
  return {
    name: WORKFLOW_TOOL,
    definition: workflowDefinition,
    schema: () => workflowSchema,
    async validate(input) {
      const resolved = await resolveWorkflowSource(input, options);
      return "error" in resolved ? resolved.error : undefined;
    },
    async check() {
      return { behavior: "ask", prompt: WORKFLOW_REVIEW_PROMPT };
    },
    async run() {
      throw new WorkflowInputError(WORKFLOW_NOT_LAUNCHED);
    },
  };
}
