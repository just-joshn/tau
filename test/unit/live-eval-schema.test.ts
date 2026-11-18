import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, onTestFinished, test } from "bun:test";
import {
  caseSchema,
  loadCases,
  overlaps,
  subsets,
  type EvalCase,
} from "../../scripts/live-eval/schema.js";

const repoCases = resolve("evals/live");

const valid: EvalCase = {
  caseId: "sample-case",
  version: 1,
  priority: "P1",
  category: "lookup",
  intent: "What is in a.txt?",
  allowedTools: ["Read"],
  workspace: { files: { "a.txt": "hello" } },
  oracle: { checks: [{ kind: "answer-matches", pattern: "hello" }] },
  acceptedVariations: [],
  budget: {
    maxTurns: 4,
    maxOutputTokensPerCall: 4000,
    maxCostUsd: 0.5,
    timeoutMs: 60_000,
  },
  rubric: ["Quotes the file."],
};

test("every repository case validates and every subset has a seed case", () => {
  const cases = loadCases(repoCases);
  for (const subset of subsets)
    expect(cases.some((evalCase) => evalCase.subset === subset)).toBe(true);
  for (const evalCase of cases.filter(
    (entry) => entry.subset === "adversarial",
  )) {
    expect(evalCase.priority).toBe("P0");
    expect((evalCase.exposedTools ?? []).length).toBeGreaterThan(
      evalCase.allowedTools.length,
    );
  }
});

test("repository subsets share no caseId or intent", () => {
  expect(overlaps(loadCases(repoCases))).toEqual([]);
});

test("overlaps reports a caseId or intent reused across subsets", async () => {
  const root = await mkdtemp(join(tmpdir(), "tau-eval-cases-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  for (const subset of subsets) await mkdir(join(root, subset));
  await writeFile(
    join(root, "development/sample-case.json"),
    JSON.stringify(valid),
  );
  await writeFile(
    join(root, "holdout/sample-case.json"),
    JSON.stringify(valid),
  );
  await writeFile(
    join(root, "regression/other-case.json"),
    JSON.stringify({
      ...valid,
      caseId: "other-case",
      intent: "  WHAT is in a.txt? ",
    }),
  );
  expect(overlaps(loadCases(root))).toEqual([
    'caseId "sample-case" appears in development and holdout',
    'intent "  WHAT is in a.txt? " appears in development and regression',
    'intent "What is in a.txt?" appears in regression and holdout',
  ]);
});

test("loadCases rejects a file whose name differs from its caseId", async () => {
  const root = await mkdtemp(join(tmpdir(), "tau-eval-cases-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "development"));
  await writeFile(
    join(root, "development/renamed.json"),
    JSON.stringify(valid),
  );
  expect(() => loadCases(root, ["development"])).toThrow(
    /does not match the file name/,
  );
});

test.each([
  [
    "a workspace path escaping the workspace",
    { workspace: { files: { "../x": "" } } },
  ],
  ["an absolute workspace path", { workspace: { files: { "/etc/x": "" } } }],
  ["an allowed tool that is not exposed", { exposedTools: ["Glob"] }],
  [
    "file-unchanged on a path that is not a fixture",
    { oracle: { checks: [{ kind: "file-unchanged", path: "b" }] } },
  ],
  [
    "an invalid oracle pattern",
    { oracle: { checks: [{ kind: "answer-matches", pattern: "(" }] } },
  ],
  ["an unknown field", { expectedActions: ["Read"] }],
  [
    "a cost budget above the hard ceiling",
    { budget: { ...valid.budget, maxCostUsd: 50 } },
  ],
  ["an empty rubric", { rubric: [] }],
])("caseSchema rejects %s", (_name, patch) => {
  expect(caseSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
});

test("caseSchema accepts the minimal valid case", () => {
  expect(caseSchema.parse(valid)).toEqual(valid);
});
