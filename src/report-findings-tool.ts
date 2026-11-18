/**
 * ReportFindings (chunk-fkkma3m4.js). The host UI reads the tool input.
 * The model-facing result is the original count sentence.
 */
import { z } from "zod";
import { REPORT_FINDINGS_DESCRIPTION } from "./eager-catalog-text.js";
import type { GuardedTool } from "./guarded-tool.js";
import type { ToolDefinition } from "./types.js";

export const REPORT_FINDINGS_TOOL = "ReportFindings";
export const REPORT_FINDINGS_SEARCH_HINT =
  "report code-review findings as a structured list";

const effort = ["low", "medium", "high", "xhigh", "max"] as const;
const verdict = ["CONFIRMED", "PLAUSIBLE"] as const;
const outcome = ["fixed", "skipped", "no_change_needed"] as const;
const findingSchema = z
  .object({
    file: z
      .string()
      .describe("Repo-relative path of the file the finding is in"),
    line: z
      .number()
      .int()
      .optional()
      .describe("1-indexed line the finding anchors to"),
    summary: z.string().describe("One-sentence statement of the defect"),
    short_summary: z
      .string()
      .max(60)
      .optional()
      .describe(
        "Compressed label for compact UI (\u226460 chars): the claim alone, no rationale or consequence clause",
      ),
    failure_scenario: z
      .string()
      .describe("Concrete inputs/state \u2192 wrong output/crash"),
    category: z
      .string()
      .max(40)
      .optional()
      .describe(
        'Short kebab-case slug of the finding type, e.g. "correctness", "simplification", "efficiency", "test-coverage"',
      ),
    verdict: z
      .enum(verdict)
      .optional()
      .describe("Set when a verify pass ran; absent on inline-only reviews"),
    outcome: z
      .enum(outcome)
      .optional()
      .describe(
        "Set ONLY when re-reporting after applying fixes: what happened to this finding",
      ),
  })
  .strict();
const reportFindingsSchema = z
  .object({
    level: z
      .enum(effort)
      .optional()
      .describe("Effort level the review ran at"),
    findings: z
      .array(findingSchema)
      .max(32)
      .describe("Verified findings, most-severe first; empty if none survived"),
  })
  .strict();
export type ReportFindingsInput = z.infer<typeof reportFindingsSchema>;

export function reportFindingsText(count: number): string {
  if (count === 0) return "No findings reported.";
  return `${count} ${count === 1 ? "finding" : "findings"} reported.`;
}

export function reportFindingsDefinition(): ToolDefinition {
  return {
    name: REPORT_FINDINGS_TOOL,
    description: REPORT_FINDINGS_DESCRIPTION,
    input_schema: {
      ...z.toJSONSchema(reportFindingsSchema, { io: "input" }),
      type: "object",
    },
  };
}

export function reportFindingsTool(): GuardedTool<ReportFindingsInput> {
  return {
    name: REPORT_FINDINGS_TOOL,
    definition: reportFindingsDefinition,
    schema: () => reportFindingsSchema,
    async check() {
      return { behavior: "allow" };
    },
    async run(input) {
      return reportFindingsText(input.findings.length);
    },
  };
}
