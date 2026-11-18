// Runs the suite under istanbul instrumentation and gates branch coverage.
//
//   bun scripts/coverage/run.ts [--serial] [--focus <src path>]...
//     [--merge <coverage-final.json>] [-- <extra bun test args>]
//
// Writes coverage/coverage-final.json, lcov.info and coverage-summary.json.
// --focus narrows printing and gating to the named files and lists each of
// their uncovered branches. --merge unions a saved coverage-final.json first.
import {
  createCoverageMap,
  type CoverageMap,
  type CoverageMapData,
  type Totals,
} from "istanbul-lib-coverage";
import { createContext } from "istanbul-lib-report";
import { create } from "istanbul-reports";
import { createInstrumenter } from "istanbul-lib-instrument";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { INSTRUMENTER_OPTIONS } from "./instrument.ts";

const BRANCH_FLOOR = 80; // total and every src file
const LINE_FLOOR = 85; // total
const FUNCTION_FLOOR = 85; // total

const root = resolve(import.meta.dir, "../..");
const coverageDir = join(root, "coverage");
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    serial: { type: "boolean", default: false },
    focus: { type: "string", multiple: true, default: [] },
    merge: { type: "string" },
  },
  allowPositionals: true,
});
const focus = values.focus.map((file) => resolve(root, file));

// Read --merge before cleaning, since it may live under coverage/.
const merged =
  values.merge === undefined ? undefined : readCoverage(values.merge);
rmSync(coverageDir, { recursive: true, force: true });

const preload = `--preload=${join(import.meta.dir, "instrument.ts")}`;
const testRun = Bun.spawnSync(
  [
    process.execPath,
    "test",
    ...(values.serial ? [] : ["--parallel"]),
    ...positionals,
  ],
  {
    cwd: root,
    stdio: ["inherit", "inherit", "inherit"],
    env: {
      ...process.env,
      TAU_COVERAGE_DIR: coverageDir,
      BUN_OPTIONS: [process.env.BUN_OPTIONS, preload].filter(Boolean).join(" "),
    },
  },
);

const map = createCoverageMap({});
const rawDir = join(coverageDir, "raw");
const rawFiles = existsSync(rawDir)
  ? readdirSync(rawDir).filter((name) => name.endsWith(".json"))
  : [];
for (const name of rawFiles) map.merge(readCoverage(join(rawDir, name)));
if (merged !== undefined) map.merge(merged);
zeroFillUnloadedSources(map);
console.log(
  `merged ${rawFiles.length} raw coverage files${values.merge === undefined ? "" : ` and ${values.merge}`}`,
);

const context = createContext({ dir: coverageDir, coverageMap: map });
for (const report of ["json", "lcovonly", "json-summary"] as const)
  create(report, { file: outputName(report) }).execute(context);

// Printing and gating cover the focused files, or every file.
if (focus.length > 0) map.filter((file) => focus.includes(file));
create("text-summary").execute(
  createContext({ dir: coverageDir, coverageMap: map }),
);
const violations: string[] = [];
const total = map.getCoverageSummary();
checkFloor("total branches", total.branches, BRANCH_FLOOR);
checkFloor("total lines", total.lines, LINE_FLOOR);
checkFloor("total functions", total.functions, FUNCTION_FLOOR);
for (const file of map.files().sort())
  checkFloor(
    `${relative(root, file)} branches`,
    map.fileCoverageFor(file).toSummary().branches,
    BRANCH_FLOOR,
  );
if (focus.length > 0) printUncoveredBranches(map);
if (testRun.exitCode !== 0)
  violations.push(`bun test exited with ${testRun.exitCode}`);

if (violations.length > 0) {
  console.error(`\ncoverage gate failed (${violations.length}):`);
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
console.log("\ncoverage gate passed");

function checkFloor(label: string, totals: Totals, floor: number) {
  if (totals.total > 0 && totals.pct < floor)
    violations.push(
      `${label} ${totals.pct.toFixed(2)}% (${totals.covered}/${totals.total}) < ${floor}%`,
    );
}

function outputName(report: "json" | "lcovonly" | "json-summary"): string {
  switch (report) {
    case "json":
      return "coverage-final.json";
    case "lcovonly":
      return "lcov.info";
    case "json-summary":
      return "coverage-summary.json";
  }
}

function readCoverage(path: string): CoverageMapData {
  const data: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isCoverageMapData(data))
    throw new Error(`${path} is not an istanbul coverage map`);
  return data;
}

function isCoverageMapData(value: unknown): value is CoverageMapData {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every(
      (file) =>
        typeof file === "object" &&
        file !== null &&
        "path" in file &&
        "branchMap" in file,
    )
  );
}

// A source no test loaded still counts, with every counter at zero.
function zeroFillUnloadedSources(coverage: CoverageMap) {
  const loaded = new Set(coverage.files());
  const instrumenter = createInstrumenter(INSTRUMENTER_OPTIONS);
  const sources = readdirSync(join(root, "src"), {
    recursive: true,
    encoding: "utf8",
  })
    .filter((file) => file.endsWith(".ts"))
    .map((file) => join(root, "src", file));
  for (const file of sources) {
    if (loaded.has(file)) continue;
    instrumenter.instrumentSync(readFileSync(file, "utf8"), file);
    coverage.addFileCoverage(instrumenter.lastFileCoverage());
  }
}

function printUncoveredBranches(coverage: CoverageMap) {
  console.log("\nuncovered branches:");
  for (const file of coverage.files().sort()) {
    const { branchMap, b } = coverage.fileCoverageFor(file).data;
    Object.entries(branchMap)
      .flatMap(([id, branch]) =>
        (b[id] ?? []).flatMap((count, arm) => {
          if (count > 0) return [];
          // An implicit else has no location of its own.
          const start = branch.locations[arm]?.start ?? branch.loc.start;
          const line = start.line ?? branch.loc.start.line;
          const column = (start.column ?? branch.loc.start.column) + 1;
          const arms = branch.locations.length;
          const label = arms > 1 ? ` arm ${arm + 1}/${arms}` : "";
          return [{ line, column, text: `${branch.type}${label}` }];
        }),
      )
      .sort((a, b) => a.line - b.line || a.column - b.column)
      .forEach(({ line, column, text }) =>
        console.log(`${relative(root, file)}:${line}:${column} ${text}`),
      );
  }
}
