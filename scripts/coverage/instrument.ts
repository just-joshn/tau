// Bun preload that instruments <repo>/src/**/*.ts with istanbul, because
// Bun's own coverage has no branch data. scripts/coverage/run.ts loads it into
// the test runner and every descendant bun process through BUN_OPTIONS, and
// each process writes its counters to $TAU_COVERAGE_DIR/raw/<pid>-<n>.json.
import { plugin } from "bun";
import type { CoverageMapData } from "istanbul-lib-coverage";
import { createInstrumenter } from "istanbul-lib-instrument";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

declare global {
  var __coverage__: CoverageMapData | undefined;
}

const root = resolve(import.meta.dir, "../..");
const outputDir = process.env.TAU_COVERAGE_DIR;

export const INSTRUMENTER_OPTIONS = {
  esModules: true,
  parserPlugins: ["typescript"],
  coverageVariable: "__coverage__",
};

if (outputDir !== undefined) {
  installInstrumenter();
  await installFlush(join(outputDir, "raw"));
}

function installInstrumenter() {
  const cacheDir = join(root, "node_modules", ".cache", "tau-coverage");
  const version = instrumenterVersion();
  const sourceRoot = join(root, "src").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let instrumenter: ReturnType<typeof createInstrumenter> | undefined;
  plugin({
    name: "tau-istanbul",
    setup(build) {
      build.onLoad(
        { filter: new RegExp(`^${sourceRoot}/.*\\.ts$`) },
        ({ path }) => {
          const source = readFileSync(path, "utf8");
          const key = createHash("sha256")
            .update(version)
            .update("\0")
            .update(path)
            .update("\0")
            .update(source)
            .digest("hex");
          const cached = join(cacheDir, `${key}.ts`);
          if (existsSync(cached))
            return { contents: readFileSync(cached, "utf8"), loader: "ts" };
          instrumenter ??= createInstrumenter(INSTRUMENTER_OPTIONS);
          const contents = instrumenter.instrumentSync(source, path);
          mkdirSync(cacheDir, { recursive: true });
          const temporary = `${cached}.${process.pid}.${crypto.randomUUID()}`;
          writeFileSync(temporary, contents);
          renameSync(temporary, cached);
          return { contents, loader: "ts" };
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
  const version =
    typeof manifest === "object" && manifest !== null && "version" in manifest
      ? String(manifest.version)
      : "unknown";
  return `${version} ${JSON.stringify(INSTRUMENTER_OPTIONS)}`;
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
