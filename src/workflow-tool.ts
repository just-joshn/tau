/**
 * Workflow (chunk-082xbwcm.js WorkflowTool). Input checks follow the
 * original resolve order. There is no script executor, so a script that
 * passes those checks is refused instead of launched.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type AnyNode, type ObjectExpression, parse } from "acorn";
import { z } from "zod";
import { WORKFLOW_DESCRIPTION } from "./eager-catalog-text.js";
import type { GuardedTool } from "./guarded-tool.js";
import type { ToolDefinition } from "./types.js";
import { runWorkflowBody } from "./workflow-runtime.js";

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

export interface WorkflowMeta {
  name: string;
  description: string;
  title?: string;
  whenToUse?: string;
  phases?: Array<{ title: string; detail?: string; model?: string }>;
}
export type ParsedWorkflow =
  | { meta: WorkflowMeta; scriptBody: string }
  | { error: string };

const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const PLAIN_JS_HINT =
  "Workflow scripts must be plain JavaScript \u2014 common causes are TypeScript syntax (type annotations, interfaces, generics) and broken string quoting or escaping.";

/** First statement is `export const meta = {…}` → its object literal. */
function metaObjectExpr(node: AnyNode): ObjectExpression | undefined {
  if (node.type !== "ExportNamedDeclaration") return undefined;
  const decl = node.declaration;
  if (decl?.type !== "VariableDeclaration") return undefined;
  if (decl.kind !== "const" || decl.declarations.length !== 1) return undefined;
  const first = decl.declarations[0];
  if (
    first?.id.type !== "Identifier" ||
    first.id.name !== "meta" ||
    first.init?.type !== "ObjectExpression"
  )
    return undefined;
  return first.init;
}

function literalValue(node: AnyNode): unknown {
  switch (node.type) {
    case "Literal":
      return node.value;
    case "ArrayExpression":
      return node.elements.map((element) => {
        if (element === null) throw new Error("sparse arrays not allowed");
        if (element.type === "SpreadElement")
          throw new Error("spread not allowed in meta");
        return literalValue(element);
      });
    case "ObjectExpression":
      return objectValue(node);
    case "TemplateLiteral":
      if (node.expressions.length > 0)
        throw new Error("template interpolation not allowed in meta");
      return node.quasis.map((quasi) => quasi.value.cooked ?? "").join("");
    case "UnaryExpression":
      if (
        node.operator === "-" &&
        node.argument.type === "Literal" &&
        typeof node.argument.value === "number"
      )
        return -node.argument.value;
      throw new Error("only negative-number unary allowed in meta");
    default:
      throw new Error(`non-literal node type in meta: ${node.type}`);
  }
}

function objectValue(node: ObjectExpression): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const prop of node.properties) {
    if (prop.type !== "Property")
      throw new Error("only plain properties allowed in meta");
    if (prop.computed) throw new Error("computed keys not allowed in meta");
    if (prop.method || prop.kind !== "init")
      throw new Error("methods/accessors not allowed in meta");
    let key: string;
    if (prop.key.type === "Identifier") key = prop.key.name;
    else if (prop.key.type === "Literal") key = String(prop.key.value);
    else throw new Error(`unsupported key type in meta: ${prop.key.type}`);
    if (RESERVED_KEYS.has(key))
      throw new Error(`reserved key name not allowed in meta: ${key}`);
    out[key] = literalValue(prop.value);
  }
  return out;
}

function metaPhases(value: unknown): WorkflowMeta["phases"] {
  if (!Array.isArray(value)) return undefined;
  const phases: NonNullable<WorkflowMeta["phases"]> = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const title: unknown = Reflect.get(item, "title");
    if (typeof title !== "string") continue;
    const detail: unknown = Reflect.get(item, "detail");
    const model: unknown = Reflect.get(item, "model");
    phases.push({
      title,
      ...(typeof detail === "string" ? { detail } : {}),
      ...(typeof model === "string" ? { model } : {}),
    });
  }
  return phases.length > 0 ? phases : undefined;
}

function validateMeta(raw: Record<string, unknown>): ParsedWorkflow | {
  meta: WorkflowMeta;
} {
  const { name, description, title, whenToUse } = raw;
  if (typeof name !== "string" || name.length === 0)
    return { error: "meta.name must be a non-empty string" };
  if (typeof description !== "string" || description.length === 0)
    return { error: "meta.description must be a non-empty string" };
  const phases = metaPhases(raw.phases);
  return {
    meta: {
      name,
      description,
      ...(typeof title === "string" && title.length > 0 ? { title } : {}),
      ...(typeof whenToUse === "string" ? { whenToUse } : {}),
      ...(phases ? { phases } : {}),
    },
  };
}

/** Original `XT`: meta must be the first statement, a pure literal. */
export function parseWorkflowScript(text: string): ParsedWorkflow {
  if (text.length > SCRIPT_BYTES)
    return { error: `Script exceeds ${SCRIPT_BYTES} bytes` };
  let program;
  try {
    program = parse(text, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Script parse error: ${message}. ${PLAIN_JS_HINT}` };
  }
  const first = program.body[0];
  const init = first ? metaObjectExpr(first) : undefined;
  if (!first || !init)
    return {
      error:
        "`export const meta = { name, description, phases }` must be the FIRST statement in the script",
    };
  let raw: Record<string, unknown>;
  try {
    raw = objectValue(init);
  } catch (error) {
    return {
      error: `meta must be a pure literal: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const checked = validateMeta(raw);
  if ("error" in checked) return checked;
  return {
    meta: checked.meta,
    scriptBody: text
      .slice(first.end)
      .replace(/^[;\s]*\n/, "")
      .trimStart(),
  };
}

/** Script body with the leading meta removed; unparseable text is returned unchanged. */
export function stripWorkflowMeta(text: string): string {
  const parsed = parseWorkflowScript(text);
  return "error" in parsed ? text : parsed.scriptBody;
}

/** Original parse then `es()` body check; returns the XT error, `SyntaxError: …`, or undefined. */
export function compileWorkflowBody(text: string): string | undefined {
  const parsed = parseWorkflowScript(text);
  if ("error" in parsed) return parsed.error;
  try {
    new Function(
      `async function _check() {'use strict';\n${parsed.scriptBody}\n}`,
    );
    return undefined;
  } catch (error) {
    return error instanceof SyntaxError
      ? `SyntaxError: ${error.message}`
      : undefined;
  }
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
      const parsed = parseWorkflowScript(text);
      if ("meta" in parsed)
        found.set(parsed.meta.name, { name: parsed.meta.name, text, path });
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
      if ("error" in resolved) return resolved.error;
      return compileWorkflowBody(resolved.text);
    },
    async check() {
      return { behavior: "ask", prompt: WORKFLOW_REVIEW_PROMPT };
    },
    async run(input) {
      const resolved = await resolveWorkflowSource(input, options);
      if ("error" in resolved) throw new WorkflowInputError(resolved.error);
      const execution = await runWorkflowBody(resolved.text, {
        args: input.args,
      });
      if (execution.kind === "failed")
        throw new WorkflowInputError(`Workflow failed: ${execution.error}`);
      return JSON.stringify(execution);
    },
  };
}
