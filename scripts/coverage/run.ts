// Runs the suite under istanbul instrumentation and gates branch coverage.
//
//   bun scripts/coverage/run.ts [--serial] [--focus <src path>]...
//     [--merge <coverage-final.json>] [<bun test args>]
//
// Every other argument goes to bun test, so the package script takes
// `bun run test:coverage -- --reporter=junit` (bun run drops the "--").
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
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { mergeableCoverage, parseRunArgs, resolveFocus } from "./gate.ts";
import { cachedInstrumentation, INSTRUMENTER_OPTIONS } from "./instrument.ts";

const BRANCH_FLOOR = 80; // total and every src file
const LINE_FLOOR = 85; // total
const FUNCTION_FLOOR = 85; // total

const root = resolve(import.meta.dir, "../..");
const coverageDir = join(root, "coverage");
const {
  serial,
  mergePath,
  focus: focusArgs,
  testArgs,
} = parseRunArgs(process.argv.slice(2));

// Read --merge before cleaning, since it may live under coverage/.
const merged = mergePath === undefined ? undefined : readCoverage(mergePath);
rmSync(coverageDir, { recursive: true, force: true });

// Every source starts at zero, so one no test loaded still counts.
const map = createCoverageMap({});
for (const fileCoverage of instrumentSources())
  map.addFileCoverage(fileCoverage);
const focus = resolveFocus(root, focusArgs, map.files());
const saved = merged === undefined ? undefined : mergeableCoverage(merged, map);
for (const path of saved?.stale ?? [])
  console.warn(
    `skipping ${relative(root, path)} from ${mergePath}: it no longer matches the source`,
  );

const preload = `--preload=${join(import.meta.dir, "instrument.ts")}`;
const testRun = Bun.spawnSync(
  [process.execPath, "test", ...(serial ? [] : ["--parallel"]), ...testArgs],
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

const rawDir = join(coverageDir, "raw");
const rawFiles = existsSync(rawDir)
  ? readdirSync(rawDir).filter((name) => name.endsWith(".json"))
  : [];
for (const name of rawFiles) map.merge(readCoverage(join(rawDir, name)));
if (saved !== undefined) map.merge(saved.fresh);
console.log(
  `merged ${rawFiles.length} raw coverage files${mergePath === undefined ? "" : ` and ${mergePath}`}`,
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

// Instruments every src file once, here, and fills the cache the preload
// reads. Without this a cold cache makes each spawned CLI run babel over
// every module it imports, about 1.2s per child instead of 0.2s, and the
// parallel CLI tests then miss their deadlines. Returns each file's coverage
// with every counter at zero.
function instrumentSources() {
  const instrumenter = createInstrumenter(INSTRUMENTER_OPTIONS);
  return readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .map((file) => {
      const path = join(root, "src", file);
      const source = readFileSync(path, "utf8");
      const contents = instrumenter.instrumentSync(source, path);
      const cached = cachedInstrumentation(path, source);
      if (!existsSync(cached)) {
        mkdirSync(dirname(cached), { recursive: true });
        const temporary = `${cached}.${process.pid}`;
        writeFileSync(temporary, contents);
        renameSync(temporary, cached);
      }
      return instrumenter.lastFileCoverage();
    });
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
