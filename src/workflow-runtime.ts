/**
 * Return-only Workflow executor. Compiles the meta-stripped body as an async
 * function (chunk-9fnnyw59.js `es()`); agent/parallel/pipeline/phase/log are
 * stubs that throw, so scripts needing them fail instead of faking success.
 */
import { parseWorkflowScript } from "./workflow-tool.js";

export type WorkflowExecution =
  | { kind: "completed"; result: unknown; durationMs: number }
  | { kind: "failed"; error: string; durationMs: number };

export interface WorkflowRunOptions {
  args?: unknown;
}

const HOST_FUNCTIONS = ["agent", "parallel", "pipeline", "phase", "log"];

function unavailable(name: string) {
  return () => {
    throw new Error(`${name}() is not available in this build`);
  };
}

function message(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export async function runWorkflowBody(
  script: string,
  options: WorkflowRunOptions = {},
): Promise<WorkflowExecution> {
  const start = Date.now();
  const elapsed = () => Date.now() - start;
  const parsed = parseWorkflowScript(script);
  if ("error" in parsed)
    return { kind: "failed", error: parsed.error, durationMs: elapsed() };
  try {
    const args =
      options.args === undefined
        ? undefined
        : JSON.parse(JSON.stringify(options.args));
    const body = new Function(
      "args",
      ...HOST_FUNCTIONS,
      `return (async () => {'use strict';\n${parsed.scriptBody}\n})();`,
    );
    const result = await body(args, ...HOST_FUNCTIONS.map(unavailable));
    return { kind: "completed", result, durationMs: elapsed() };
  } catch (error) {
    return { kind: "failed", error: message(error), durationMs: elapsed() };
  }
}
