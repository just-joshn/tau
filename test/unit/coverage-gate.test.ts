// The istanbul coverage gate in scripts/coverage must not report a number it
// did not measure.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { createInstrumenter } from "istanbul-lib-instrument";
import {
  createCoverageMap,
  type CoverageMapData,
  type FileCoverageData,
} from "istanbul-lib-coverage";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  mergeableCoverage,
  parseRunArgs,
  readCoverage,
  resolveFocus,
} from "../../scripts/coverage/gate.ts";
import { INSTRUMENTER_OPTIONS } from "../../scripts/coverage/instrument.ts";

const root = resolve(import.meta.dir, "../..");
const sources = [join(root, "src/read.ts"), join(root, "src/retry.ts")];

test("--focus resolves a src file to its absolute path", () => {
  assert.deepEqual(resolveFocus(root, ["src/read.ts"], sources), [
    join(root, "src/read.ts"),
  ]);
});

test("--focus naming no instrumented src file fails the run", () => {
  assert.throws(
    () => resolveFocus(root, ["src/read.ts", "src/read.js"], sources),
    /src\/read\.js/,
  );
});

test("--focus without a value fails the run", () => {
  assert.throws(() => parseRunArgs(["--focus"]), /--focus/);
});

const path = join(root, "src/example.ts");
const source = "export const pick = (a: boolean) => (a ? 1 : 2);\n";

/** A fresh empty directory. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "tau-coverage-"));
}

/** `code` instrumented as `path`, every counter at zero. */
function instrumented(code: string): FileCoverageData {
  const instrumenter = createInstrumenter(INSTRUMENTER_OPTIONS);
  instrumenter.instrumentSync(code, path);
  return instrumenter.lastFileCoverage();
}

/** A saved coverage-final.json of `code`, read back, whose every arm ran. */
function savedRun(code: string): CoverageMapData {
  const data = instrumented(code);
  for (const [id, arms] of Object.entries(data.b))
    data.b[id] = arms.map(() => 1);
  const file = join(scratch(), "saved.json");
  writeFileSync(file, JSON.stringify({ [path]: data }));
  return readCoverage(file);
}

test("--merge adds the hits of a saved run of the same source", () => {
  const current = createCoverageMap({});
  current.addFileCoverage(instrumented(source));
  current.merge(mergeableCoverage(savedRun(source), current).fresh);
  const { branches } = current.getCoverageSummary();
  assert.equal(branches.total, 2);
  assert.equal(branches.covered, 2);
});

test("--merge ignores a saved run of a since-edited source", () => {
  const current = createCoverageMap({});
  current.addFileCoverage(instrumented(`\n${source}`));
  const { fresh, stale } = mergeableCoverage(savedRun(source), current);
  current.merge(fresh);
  const { branches } = current.getCoverageSummary();
  assert.equal(branches.total, 2);
  assert.equal(branches.covered, 0);
  assert.deepEqual(stale, [path]);
});

const instrumentPath = join(root, "scripts/coverage/instrument.ts");

test("a child killed while flushing coverage leaves no partial raw file", () => {
  const outputDir = scratch();
  const child = join(scratch(), "child.js");
  writeFileSync(
    child,
    `await import(process.argv[2]);
globalThis.__coverage__ = { "/x.ts": { path: "/x.ts", pad: "x".repeat(1 << 20) } };
`,
  );
  // A file size limit kills the child with SIGXFSZ partway through the write.
  const run = Bun.spawnSync(
    [
      "/bin/sh",
      "-c",
      'ulimit -f 8 && exec "$@"',
      "sh",
      process.execPath,
      child,
      instrumentPath,
    ],
    { env: { PATH: process.env.PATH, TAU_COVERAGE_DIR: outputDir } },
  );
  assert.notEqual(run.exitCode, 0);
  const rawDir = join(outputDir, "raw");
  assert.ok(existsSync(rawDir));
  for (const name of readdirSync(rawDir).filter((file) =>
    file.endsWith(".json"),
  ))
    assert.doesNotThrow(
      () => JSON.parse(readFileSync(join(rawDir, name), "utf8")),
      name,
    );
});

/** The instrumentation cache file for one source under an install whose
 * packages have the given versions. */
function cacheKey(versions: Record<string, string>): string {
  const fakeRoot = scratch();
  mkdirSync(join(fakeRoot, "scripts/coverage"), { recursive: true });
  copyFileSync(
    instrumentPath,
    join(fakeRoot, "scripts/coverage/instrument.ts"),
  );
  for (const [name, version] of Object.entries(versions)) {
    mkdirSync(join(fakeRoot, "node_modules", name), { recursive: true });
    writeFileSync(
      join(fakeRoot, "node_modules", name, "package.json"),
      JSON.stringify({ name, version }),
    );
  }
  const probe = join(scratch(), "probe.js");
  writeFileSync(
    probe,
    `const { cachedInstrumentation } = await import(process.argv[2]);
console.log(cachedInstrumentation("/src/a.ts", "export {};"));
`,
  );
  const run = Bun.spawnSync(
    [process.execPath, probe, join(fakeRoot, "scripts/coverage/instrument.ts")],
    { env: { PATH: process.env.PATH } },
  );
  assert.equal(run.exitCode, 0, run.stderr.toString());
  return basename(run.stdout.toString().trim());
}

test("upgrading babel invalidates the instrumentation cache", () => {
  const installed = {
    "istanbul-lib-instrument": "6.0.3",
    "@babel/core": "7.29.13",
    "@babel/parser": "7.29.14",
  };
  const before = cacheKey(installed);
  assert.equal(cacheKey(installed), before);
  assert.notEqual(cacheKey({ ...installed, "@babel/core": "7.30.0" }), before);
  assert.notEqual(
    cacheKey({ ...installed, "@babel/parser": "7.30.0" }),
    before,
  );
});
