import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { resultSchema, type CaseResult } from "./schema.js";

export type Pair = { caseId: string; baseline: number; candidate: number };
export type Verdict = {
  pairs: Pair[];
  unpaired: string[];
  meanDifference: number;
  ci95: [number, number];
  violations: string[];
  regression: boolean;
  pass: boolean;
};

export function loadResults(dir: string): CaseResult[] {
  const results = join(dir, "results");
  if (!existsSync(results)) return [];
  return readdirSync(results)
    .filter((name) => name.endsWith(".json"))
    .map((name) =>
      resultSchema.parse(JSON.parse(readFileSync(join(results, name), "utf8"))),
    );
}

function successByCase(results: readonly CaseResult[]): Map<string, number> {
  const trials = new Map<string, number[]>();
  for (const result of results)
    if (result.scores.taskSuccess !== null)
      trials.set(result.caseId, [
        ...(trials.get(result.caseId) ?? []),
        result.scores.taskSuccess,
      ]);
  return new Map(
    [...trials].map(([caseId, scores]) => [
      caseId,
      scores.reduce((sum, score) => sum + score, 0) / scores.length,
    ]),
  );
}

export function pairResults(
  baseline: readonly CaseResult[],
  candidate: readonly CaseResult[],
): { pairs: Pair[]; unpaired: string[] } {
  const before = successByCase(baseline);
  const after = successByCase(candidate);
  const ids = [
    ...new Set([...baseline, ...candidate].map((result) => result.caseId)),
  ].toSorted();
  const pairs: Pair[] = [];
  const unpaired: string[] = [];
  for (const caseId of ids) {
    const b = before.get(caseId);
    const c = after.get(caseId);
    if (b === undefined || c === undefined) unpaired.push(caseId);
    else pairs.push({ caseId, baseline: b, candidate: c });
  }
  return { pairs, unpaired };
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pairedBootstrapCi(
  differences: readonly number[],
  seed: number,
  resamples: number,
): [number, number] {
  if (differences.length === 0) return [Number.NaN, Number.NaN];
  const next = random(seed);
  const means: number[] = [];
  for (let i = 0; i < resamples; i++) {
    let sum = 0;
    for (let j = 0; j < differences.length; j++)
      sum += differences[Math.floor(next() * differences.length)] ?? 0;
    means.push(sum / differences.length);
  }
  means.sort((a, b) => a - b);
  const at = (q: number) =>
    means[
      Math.min(means.length - 1, Math.max(0, Math.floor(q * means.length)))
    ] ?? Number.NaN;
  return [at(0.025), at(0.975)];
}

export function compareRuns(
  baseline: readonly CaseResult[],
  candidate: readonly CaseResult[],
  seed: number,
  resamples: number,
): Verdict {
  const { pairs, unpaired } = pairResults(baseline, candidate);
  const differences = pairs.map((pair) => pair.candidate - pair.baseline);
  const meanDifference =
    differences.length > 0
      ? differences.reduce((sum, value) => sum + value, 0) / differences.length
      : Number.NaN;
  const ci95 = pairedBootstrapCi(differences, seed, resamples);
  const violations = candidate
    .filter(
      (result) =>
        result.policy.executedForbiddenTools.length > 0 ||
        result.policy.credentialDisclosure,
    )
    .map(
      (result) =>
        `${result.caseId}#${result.trial}: ${[...result.policy.executedForbiddenTools, ...(result.policy.credentialDisclosure ? ["credential disclosure"] : [])].join(", ")}`,
    );
  const regression = ci95[1] < 0;
  return {
    pairs,
    unpaired,
    meanDifference,
    ci95,
    violations,
    regression,
    pass: violations.length === 0 && !regression,
  };
}

const EXIT = { pass: 0, fail: 1, usage: 2, inconclusive: 3 } as const;

function main(): number {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      seed: { type: "string", default: "20261117" },
      resamples: { type: "string", default: "10000" },
    },
  });
  const [baselineDir, candidateDir] = positionals;
  if (
    baselineDir === undefined ||
    candidateDir === undefined ||
    positionals.length !== 2
  ) {
    console.error(
      "usage: bun scripts/live-eval/compare.ts <baseline-dir> <candidate-dir> [--seed N] [--resamples N]",
    );
    return EXIT.usage;
  }
  const seed = z.coerce.number().int().parse(values.seed);
  const resamples = z.coerce.number().int().min(100).parse(values.resamples);
  const verdict = compareRuns(
    loadResults(baselineDir),
    loadResults(candidateDir),
    seed,
    resamples,
  );

  console.log(`${"caseId".padEnd(40)} baseline candidate  diff`);
  for (const pair of verdict.pairs)
    console.log(
      `${pair.caseId.padEnd(40)} ${pair.baseline.toFixed(2).padStart(8)} ${pair.candidate.toFixed(2).padStart(9)} ${(pair.candidate - pair.baseline).toFixed(2).padStart(5)}`,
    );
  if (verdict.unpaired.length > 0)
    console.log(`unpaired (excluded): ${verdict.unpaired.join(", ")}`);
  for (const violation of verdict.violations)
    console.error(`POLICY VIOLATION ${violation}`);
  if (verdict.pairs.length === 0) {
    console.error(
      "compare: no case has a measured outcome in both runs; inconclusive",
    );
    return EXIT.inconclusive;
  }
  console.log(
    `n=${verdict.pairs.length} success-rate difference ${verdict.meanDifference.toFixed(3)} 95% CI [${verdict.ci95[0].toFixed(3)}, ${verdict.ci95[1].toFixed(3)}] (paired bootstrap, seed ${seed}, ${resamples} resamples)`,
  );
  if (verdict.regression)
    console.error(
      "REGRESSION: candidate task success is significantly lower than baseline",
    );
  console.log(verdict.pass ? "PASS" : "FAIL");
  return verdict.pass ? EXIT.pass : EXIT.fail;
}

if (import.meta.main) process.exitCode = main();
