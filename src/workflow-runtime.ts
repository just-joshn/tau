/**
 * Return-only Workflow executor. Compiles the meta-stripped body as an async
 * function (chunk-9fnnyw59.js `es()`). agent/parallel/pipeline/phase/log throw
 * so scripts that need them fail instead of succeeding silently.
 */
import { parseWorkflowScript } from "./workflow-tool.js";

export type WorkflowExecution =
  | { kind: "completed"; result: unknown; durationMs: number }
  | { kind: "failed"; error: string; durationMs: number };

export interface WorkflowRunOptions {
  args?: unknown;
}

const HOST_FUNCTIONS = ["agent", "parallel", "pipeline", "phase", "log"] as const;

type HostFn = () => never;
type BodyFactory = (args: unknown, ...hosts: HostFn[]) => unknown;

function unavailable(name: string): HostFn {
  return () => {
    throw new Error(`${name}() is not available in this build`);
  };
}

function isBodyFactory(value: unknown): value is BodyFactory {
  return typeof value === "function";
}

function message(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
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
    let args: unknown;
    if (options.args === undefined) {
      args = undefined;
    } else {
      const cloned: unknown = JSON.parse(JSON.stringify(options.args));
      args = cloned;
    }
    const compiled: unknown = new Function(
      "args",
      ...HOST_FUNCTIONS,
      `return (async () => {'use strict';\n${parsed.scriptBody}\n})();`,
    );
    if (!isBodyFactory(compiled))
      return {
        kind: "failed",
        error: "Failed to compile workflow body",
        durationMs: elapsed(),
      };
    const hosts = HOST_FUNCTIONS.map((name) => unavailable(name));
    const result: unknown = await Promise.resolve(compiled(args, ...hosts));
    return { kind: "completed", result, durationMs: elapsed() };
  } catch (error) {
    return { kind: "failed", error: message(error), durationMs: elapsed() };
  }
}
