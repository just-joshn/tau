import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const subsets = [
  "development",
  "regression",
  "holdout",
  "adversarial",
] as const;
export type Subset = (typeof subsets)[number];

const relativePath = z
  .string()
  .min(1)
  .refine(
    (path) => !path.startsWith("/") && !path.split(/[\\/]/).includes(".."),
    {
      message: "workspace paths must stay inside the workspace",
    },
  );
const pattern = z
  .string()
  .min(1)
  .refine(
    (source) => {
      try {
        new RegExp(source, "i");
        return true;
      } catch {
        return false;
      }
    },
    { message: "invalid regular expression" },
  );

/** One machine-checkable assertion about the observable outcome. Patterns are case-insensitive. */
export const oracleCheckSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("answer-matches"), pattern }),
  z.object({ kind: z.literal("answer-not-matches"), pattern }),
  z.object({ kind: z.literal("file-matches"), path: relativePath, pattern }),
  z.object({
    kind: z.literal("file-not-matches"),
    path: relativePath,
    pattern,
  }),
  z.object({ kind: z.literal("file-absent"), path: relativePath }),
  z.object({ kind: z.literal("file-unchanged"), path: relativePath }),
]);
export type OracleCheck = z.infer<typeof oracleCheckSchema>;

const toolName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/);

export const caseSchema = z
  .object({
    caseId: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    version: z.number().int().positive(),
    priority: z.enum(["P0", "P1", "P2"]),
    category: z.string().min(1),
    /** The only text the agent sees. Oracle, variations and rubric never reach the model. */
    intent: z.string().min(1),
    /** Tools the agent may execute; preapproved with --allowedTools. Any other executed tool is a policy violation. */
    allowedTools: z.array(toolName).min(1),
    /** Tools advertised to the model (--tools). Defaults to allowedTools; adversarial cases advertise more. */
    exposedTools: z.array(toolName).optional(),
    workspace: z.object({ files: z.record(relativePath, z.string()) }),
    oracle: z.object({ checks: z.array(oracleCheckSchema).min(1) }),
    /** Outcomes a human adjudicator should also accept; the checks above encode them where they can. */
    acceptedVariations: z.array(z.string()),
    budget: z.object({
      maxTurns: z.number().int().min(1).max(25),
      maxOutputTokensPerCall: z.number().int().min(1024),
      maxCostUsd: z.number().positive().max(5),
      timeoutMs: z.number().int().min(10_000).max(900_000),
    }),
    rubric: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const exposed = value.exposedTools ?? value.allowedTools;
    for (const tool of value.allowedTools)
      if (!exposed.includes(tool))
        context.addIssue({
          code: "custom",
          message: `allowed tool ${tool} is not exposed`,
        });
    for (const check of value.oracle.checks)
      if (
        check.kind === "file-unchanged" &&
        !(check.path in value.workspace.files)
      )
        context.addIssue({
          code: "custom",
          message: `file-unchanged ${check.path} is not a fixture file`,
        });
  });
export type EvalCase = z.infer<typeof caseSchema>;
export type LoadedCase = EvalCase & { subset: Subset; file: string };

export function loadCases(
  root: string,
  only: readonly Subset[] = subsets,
): LoadedCase[] {
  return only.flatMap((subset) => {
    const dir = join(root, subset);
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .toSorted()
      .map((name) => {
        const file = join(dir, name);
        const parsed = caseSchema.safeParse(
          JSON.parse(readFileSync(file, "utf8")),
        );
        if (!parsed.success)
          throw new Error(`${file}: ${z.prettifyError(parsed.error)}`);
        if (`${parsed.data.caseId}.json` !== name)
          throw new Error(
            `${file}: caseId ${parsed.data.caseId} does not match the file name`,
          );
        return { ...parsed.data, subset, file };
      });
  });
}

export function overlaps(cases: readonly LoadedCase[]): string[] {
  const problems: string[] = [];
  for (const key of ["caseId", "intent"] as const) {
    const seen = new Map<string, Subset>();
    for (const evalCase of cases) {
      const value = evalCase[key].trim().toLowerCase();
      const previous = seen.get(value);
      if (previous !== undefined)
        problems.push(
          `${key} ${JSON.stringify(evalCase[key])} appears in ${previous} and ${evalCase.subset}`,
        );
      seen.set(value, evalCase.subset);
    }
  }
  return problems;
}

const score = z.union([z.literal(0), z.literal(1)]).nullable();

export const resultSchema = z.object({
  caseId: z.string(),
  caseVersion: z.number(),
  subset: z.enum(subsets),
  runId: z.string(),
  trial: z.number().int().nonnegative(),
  harnessVersion: z.string(),
  modelId: z.string(),
  toolSchemaVersion: z.string(),
  datasetVersion: z.string(),
  /** completed: the agent ran to a result; failed: harness or agent error; inconclusive: provider outage; skipped-budget: total cap reached. */
  status: z.enum(["completed", "failed", "inconclusive", "skipped-budget"]),
  reason: z.string().optional(),
  scores: z.object({
    taskSuccess: score,
    policyCompliance: score,
    budgetCompliance: score,
  }),
  policy: z.object({
    attemptedForbiddenTools: z.array(z.string()),
    executedForbiddenTools: z.array(z.string()),
    credentialDisclosure: z.boolean(),
  }),
  oracle: z.array(z.object({ check: oracleCheckSchema, passed: z.boolean() })),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheCreationInputTokens: z.number(),
    cacheReadInputTokens: z.number(),
    toolCalls: z.number(),
    turns: z.number(),
    costUsd: z.number(),
    pricing: z.string(),
  }),
  durationMs: z.number(),
  traceDigest: z.string(),
});
export type CaseResult = z.infer<typeof resultSchema>;
