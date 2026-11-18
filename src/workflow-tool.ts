/**
 * Workflow (chunk-082xbwcm.js WorkflowTool). Input checks follow the
 * original resolve order. There is no script executor, so a script that
 * passes those checks is refused instead of launched.
 */
import { readFile, stat } from "node:fs/promises";
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

export function workflowTool(): GuardedTool<WorkflowInput> {
  return {
    name: WORKFLOW_TOOL,
    definition: workflowDefinition,
    schema: () => workflowSchema,
    async validate(input) {
      if (input.scriptPath !== undefined)
        return scriptFileError(input.scriptPath);
      if (input.name !== undefined)
        return `Workflow "${input.name}" not found. Available: (none)`;
      if (input.script === undefined)
        return "Must provide script, name, or scriptPath";
      return undefined;
    },
    async check() {
      return { behavior: "ask", prompt: WORKFLOW_REVIEW_PROMPT };
    },
    async run() {
      throw new WorkflowInputError(WORKFLOW_NOT_LAUNCHED);
    },
  };
}
