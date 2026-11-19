import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, onTestFinished, test } from "bun:test";
import {
  compareRuns,
  pairedBootstrapCi,
  pairResults,
} from "../../scripts/live-eval/compare.js";
import type { CaseResult } from "../../scripts/live-eval/schema.js";

function result(
  caseId: string,
  taskSuccess: 0 | 1 | null,
  patch: Partial<CaseResult> = {},
): CaseResult {
  return {
    caseId,
    caseVersion: 1,
    subset: "regression",
    runId: "run",
    trial: 0,
    harnessVersion: "sha",
    modelId: "anthropic:claude-opus-5-5",
    toolSchemaVersion: "tau-0.1.0",
    datasetVersion: `${caseId}@v1`,
    status: taskSuccess === null ? "inconclusive" : "completed",
    scores: {
      taskSuccess,
      policyCompliance: taskSuccess === null ? null : 1,
      budgetCompliance: 1,
    },
    policy: {
      attemptedForbiddenTools: [],
      executedForbiddenTools: [],
      credentialDisclosure: false,
    },
    oracle: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      toolCalls: 0,
      turns: 1,
      costUsd: 0,
      pricing: "test",
    },
    durationMs: 1,
    traceDigest: "sha256:0",
    ...patch,
  };
}

const ids = Array.from({ length: 12 }, (_, index) => `case-${index}`);

test("pairing averages trials and excludes cases unmeasured on either side", () => {
  const baseline = [
    result("a", 1),
    result("a", 0, { trial: 1 }),
    result("b", 1),
    result("c", null),
  ];
  const candidate = [
    result("a", 1),
    result("b", 1),
    result("c", 1),
    result("d", 1),
  ];
  expect(pairResults(baseline, candidate)).toEqual({
    pairs: [
      { caseId: "a", baseline: 0.5, candidate: 1 },
      { caseId: "b", baseline: 1, candidate: 1 },
    ],
    unpaired: ["c", "d"],
  });
});

test("the paired bootstrap is deterministic for a seed and brackets the mean", () => {
  const differences = [0, 0, -1, 0, 1, 0, -1, 0, 0, 0];
  const first = pairedBootstrapCi(differences, 7, 2000);
  expect(pairedBootstrapCi(differences, 7, 2000)).toEqual(first);
  expect(first[0]).toBeLessThan(-0.1);
  expect(first[1]).toBeGreaterThanOrEqual(0);
  expect(pairedBootstrapCi([0, 0, 0], 1, 500)).toEqual([0, 0]);
});

test("identical runs pass", () => {
  const runs = ids.map((id) => result(id, 1));
  expect(compareRuns(runs, runs, 1, 2000)).toMatchObject({
    meanDifference: 0,
    ci95: [0, 0],
    pass: true,
  });
});

test("a broad task-success drop is a significant regression and fails", () => {
  const verdict = compareRuns(
    ids.map((id) => result(id, 1)),
    ids.map((id, index) => result(id, index < 3 ? 1 : 0)),
    1,
    2000,
  );
  expect(verdict.meanDifference).toBeCloseTo(-0.75, 10);
  expect(verdict.ci95[1]).toBeLessThan(0);
  expect(verdict).toMatchObject({ regression: true, pass: false });
});

test("a single-case wobble is not significant", () => {
  const verdict = compareRuns(
    ids.map((id, index) => result(id, index === 0 ? 0 : 1)),
    ids.map((id, index) => result(id, index === 1 ? 0 : 1)),
    1,
    2000,
  );
  expect(verdict).toMatchObject({ regression: false, pass: true });
});

test("any executed policy violation in the candidate fails, whatever the success rate", () => {
  const verdict = compareRuns(
    ids.map((id) => result(id, 0)),
    ids.map((id, index) =>
      result(
        id,
        1,
        index === 2
          ? {
              policy: {
                attemptedForbiddenTools: ["Bash"],
                executedForbiddenTools: ["Bash"],
                credentialDisclosure: false,
              },
            }
          : {},
      ),
    ),
    1,
    2000,
  );
  expect(verdict).toMatchObject({
    regression: false,
    violations: ["case-2#0: Bash"],
    pass: false,
  });
});

test("the CLI prints the table and exits 0 pass, 1 fail, 3 when nothing pairs", async () => {
  const root = await mkdtemp(join(tmpdir(), "tau-compare-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const write = async (name: string, results: CaseResult[]) => {
    await mkdir(join(root, name, "results"), { recursive: true });
    for (const entry of results)
      await writeFile(
        join(root, name, "results", `${entry.caseId}.t${entry.trial}.json`),
        JSON.stringify(entry),
      );
  };
  await write(
    "base",
    ids.map((id) => result(id, 1)),
  );
  await write(
    "same",
    ids.map((id) => result(id, 1)),
  );
  await write(
    "worse",
    ids.map((id) => result(id, 0)),
  );
  const compare = (a: string, b: string) =>
    Bun.spawnSync([
      process.execPath,
      resolve("scripts/live-eval/compare.ts"),
      join(root, a),
      join(root, b),
    ]);
  const same = compare("base", "same");
  expect(same.exitCode).toBe(0);
  expect(same.stdout.toString()).toContain("case-0");
  expect(same.stdout.toString()).toContain("PASS");
  expect(compare("base", "worse").exitCode).toBe(1);
  expect(compare("base", "absent").exitCode).toBe(3);
});
