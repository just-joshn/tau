//   bun scripts/mutation/run.ts [--target src/x.ts]... [--tests <path>]...
//     [--concurrency N] [--min-score 0.8]
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { EQUIVALENT_MUTANTS } from "./equivalent.ts";
import {
  applyMutant,
  describeMutant,
  enumerateMutants,
  type Mutant,
} from "./mutants.ts";

type Status = "killed" | "timeout" | "survived" | "no-coverage";
interface Result {
  file: string;
  id: string;
  mutant: Mutant;
  status: Status;
  ms: number;
  equivalent?: string;
}

const root = resolve(import.meta.dir, "../..");
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    target: {
      type: "string",
      multiple: true,
      default: [
        "src/tool-policy.ts",
        "src/permission-prompt.ts",
        "src/permission-sensitive.ts",
        "src/plugin-policy.ts",
      ],
    },
    tests: { type: "string", multiple: true, default: ["test/security"] },
    concurrency: { type: "string", default: "2" },
    "min-score": { type: "string", default: "0.8" },
  },
});
const concurrency = Number(values.concurrency);
const minScore = Number(values["min-score"]);
if (!Number.isInteger(concurrency) || concurrency < 1)
  throw new Error(`--concurrency must be a positive integer`);
if (!(minScore >= 0 && minScore <= 1))
  throw new Error(`--min-score must be between 0 and 1`);
const targets = values.target.map((file) =>
  relative(root, resolve(root, file)),
);
const preload = `--preload=${join(import.meta.dir, "preload.ts")}`;
const started = performance.now();

const mutants = targets.flatMap((file) =>
  enumerateMutants(readFileSync(join(root, file), "utf8")).map((mutant) => ({
    file,
    mutant,
    id: `${file}:${describeMutant(mutant)}`,
  })),
);
const ids = new Set(mutants.map(({ id }) => id));
const stale = Object.keys(EQUIVALENT_MUTANTS).filter(
  (id) => targets.some((file) => id.startsWith(`${file}:`)) && !ids.has(id),
);
if (stale.length > 0) {
  console.error("equivalent.ts entries match no mutant:");
  for (const id of stale) console.error(`  ${id}`);
  process.exit(1);
}

const baseline = await runTests({}, Infinity, "inherit");
if (baseline.code !== 0) {
  console.error(`unmutated tests failed (exit ${baseline.code})`);
  process.exit(1);
}
const deadline = Math.max(20_000, baseline.ms * 5);
console.log(
  `baseline passed in ${(baseline.ms / 1000).toFixed(1)}s; ${mutants.length} mutants, concurrency ${concurrency}, deadline ${(deadline / 1000).toFixed(0)}s`,
);

const scratch = mkdtempSync(join(tmpdir(), "tau-mutation-"));
const results: Result[] = [];
let next = 0;
let done = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < mutants.length) {
      const index = next++;
      const entry = mutants[index];
      if (entry === undefined) break;
      results[index] = await runMutant(entry, join(scratch, `${index}.ts`));
      if (++done % 25 === 0) console.log(`  ${done}/${mutants.length}`);
    }
  }),
);
rmSync(scratch, { recursive: true, force: true });

const summarize = (subset: readonly Result[]) => {
  const count = (status: Status) =>
    subset.filter((result) => result.status === status).length;
  return {
    mutants: subset.length,
    killed: count("killed"),
    timeout: count("timeout"),
    survived: count("survived"),
    noCoverage: count("no-coverage"),
    equivalent: subset.filter((result) => result.equivalent !== undefined)
      .length,
    score:
      subset.length === 0
        ? 1
        : subset.filter((result) => detected(result.status)).length /
          subset.length,
  };
};
const files = Object.fromEntries(
  targets.map((file) => [
    file,
    summarize(results.filter((result) => result.file === file)),
  ]),
);
const total = summarize(results);
const wallMs = performance.now() - started;

console.log("\nmutation score (killed + timeout) / mutants:");
for (const [file, summary] of Object.entries(files))
  console.log(`  ${file}: ${format(summary)}`);
console.log(`  total: ${format(total)}`);
const survivors = results.filter((result) => !detected(result.status));
if (survivors.length > 0) {
  console.log("\nsurvivors:");
  for (const result of survivors)
    console.log(
      `  ${result.id}${result.status === "no-coverage" ? " [never loaded]" : ""}${result.equivalent === undefined ? "" : `\n    equivalent: ${result.equivalent}`}`,
    );
}
console.log(
  `\nwall ${(wallMs / 1000).toFixed(1)}s at concurrency ${concurrency}`,
);

mkdirSync(join(root, "mutation-results"), { recursive: true });
writeFileSync(
  join(root, "mutation-results", "report.json"),
  `${JSON.stringify(
    {
      targets,
      tests: values.tests,
      concurrency,
      minScore,
      baselineMs: Math.round(baseline.ms),
      deadlineMs: deadline,
      wallMs: Math.round(wallMs),
      total,
      files,
      mutants: results.map(({ file, mutant, status, ms, equivalent }) => ({
        file,
        line: mutant.line,
        column: mutant.column,
        operator: mutant.operator,
        original: mutant.original,
        mutated: mutant.replacement,
        status,
        ms: Math.round(ms),
        ...(equivalent === undefined ? {} : { equivalent }),
      })),
    },
    null,
    2,
  )}\n`,
);
console.log("report: mutation-results/report.json");
if (total.score < minScore) {
  console.error(
    `mutation score ${total.score.toFixed(3)} is below --min-score ${minScore}`,
  );
  process.exit(1);
}

async function runMutant(
  entry: { file: string; mutant: Mutant; id: string },
  sourcePath: string,
): Promise<Result> {
  const original = readFileSync(join(root, entry.file), "utf8");
  writeFileSync(sourcePath, applyMutant(original, entry.mutant));
  const run = await runTests(
    { TAU_MUTANT_FILE: join(root, entry.file), TAU_MUTANT_SOURCE: sourcePath },
    deadline,
    "ignore",
  );
  const status: Status = run.timedOut
    ? "timeout"
    : run.code !== 0
      ? "killed"
      : existsSync(`${sourcePath}.loaded`)
        ? "survived"
        : "no-coverage";
  const equivalent = EQUIVALENT_MUTANTS[entry.id];
  return {
    ...entry,
    status,
    ms: run.ms,
    ...(equivalent === undefined || detected(status) ? {} : { equivalent }),
  };
}

function runTests(
  env: Record<string, string>,
  ms: number,
  stdio: "inherit" | "ignore",
): Promise<{ code: number | null; timedOut: boolean; ms: number }> {
  const begun = performance.now();
  const child = spawn(process.execPath, ["test", "--bail", ...values.tests], {
    cwd: root,
    detached: true,
    stdio: ["ignore", stdio, stdio],
    env: {
      ...process.env,
      ...env,
      BUN_OPTIONS: [process.env.BUN_OPTIONS, preload].filter(Boolean).join(" "),
    },
  });
  const killGroup = () => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      ))
        throw error;
    }
  };
  let timedOut = false;
  const timer = Number.isFinite(ms)
    ? setTimeout(() => {
        timedOut = true;
        killGroup();
      }, ms)
    : undefined;
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      killGroup();
      resolvePromise({ code, timedOut, ms: performance.now() - begun });
    });
  });
}

function detected(status: Status): boolean {
  return status === "killed" || status === "timeout";
}

function format(summary: ReturnType<typeof summarize>): string {
  return `${summary.score.toFixed(3)} (${summary.killed} killed, ${summary.timeout} timeout, ${summary.survived + summary.noCoverage} survived of ${summary.mutants}; ${summary.equivalent} equivalent)`;
}
