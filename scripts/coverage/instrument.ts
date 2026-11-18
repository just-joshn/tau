// Bun preload that loads <repo>/src/**/*.ts instrumented with istanbul,
// because Bun's own coverage has no branch data. scripts/coverage/run.ts
// instruments every source into the cache before tests start, then loads this
// preload into the test runner and every descendant bun process through
// BUN_OPTIONS. Each process only reads the cache, so a spawned CLI pays
// neither babel nor the istanbul import, and writes its counters to
// $TAU_COVERAGE_DIR/raw/<pid>-<n>.json.
import { plugin } from "bun";
import type { CoverageMapData } from "istanbul-lib-coverage";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

declare global {
  var __coverage__: CoverageMapData | undefined;
}

const root = resolve(import.meta.dir, "../..");
const cacheDir = join(root, "node_modules", ".cache", "tau-coverage");
const outputDir = process.env.TAU_COVERAGE_DIR;

export const INSTRUMENTER_OPTIONS = {
  esModules: true,
  parserPlugins: ["typescript"],
  coverageVariable: "__coverage__",
};
const version = instrumenterVersion();

/** Where the instrumented copy of `source`, read from `path`, is cached. */
export function cachedInstrumentation(path: string, source: string): string {
  const key = createHash("sha256")
    .update(version)
    .update("\0")
    .update(path)
    .update("\0")
    .update(source)
    .digest("hex");
  return join(cacheDir, `${key}.ts`);
}

if (outputDir !== undefined) {
  installLoader();
  await installFlush(join(outputDir, "raw"));
}

function installLoader() {
  const sourceRoot = join(root, "src").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  plugin({
    name: "tau-istanbul",
    setup(build) {
      build.onLoad(
        { filter: new RegExp(`^${sourceRoot}/.*\\.ts$`) },
        ({ path }) => {
          const cached = cachedInstrumentation(
            path,
            readFileSync(path, "utf8"),
          );
          try {
            return { contents: readFileSync(cached, "utf8"), loader: "ts" };
          } catch (error) {
            throw new Error(
              `${path} has no instrumented copy; run bun scripts/coverage/run.ts, which fills ${cacheDir} before tests start`,
              { cause: error },
            );
          }
        },
      );
    },
  });
}

// Options are part of the version so changing them invalidates the cache.
function instrumenterVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(
      Bun.resolveSync("istanbul-lib-instrument/package.json", root),
      "utf8",
    ),
  );
  const installed =
    typeof manifest === "object" && manifest !== null && "version" in manifest
      ? String(manifest.version)
      : "unknown";
  return `${installed} ${JSON.stringify(INSTRUMENTER_OPTIONS)}`;
}

async function installFlush(rawDir: string) {
  // bun test --parallel evaluates this preload in a fresh global per test
  // file, so the same pid flushes several times with no shared counter.
  // Exclusive create picks the next free <pid>-<n> name instead.
  const flush = () => {
    const coverage = globalThis.__coverage__;
    if (coverage === undefined) return;
    mkdirSync(rawDir, { recursive: true });
    for (let n = 0; ; n++) {
      try {
        writeFileSync(
          join(rawDir, `${process.pid}-${n}.json`),
          JSON.stringify(coverage),
          { flag: "wx" },
        );
        return;
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "EEXIST"
        ))
          throw error;
      }
    }
  };
  // The bun test runner never emits "exit"; outside the runner afterAll throws.
  try {
    const { afterAll } = await import("bun:test");
    afterAll(flush);
  } catch {
    process.on("exit", flush);
  }
}
