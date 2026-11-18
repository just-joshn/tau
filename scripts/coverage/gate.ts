// The decisions scripts/coverage/run.ts makes about its inputs, apart from
// the script so tests can drive them without spawning the suite.
import type { CoverageMap, CoverageMapData } from "istanbul-lib-coverage";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

export interface RunArgs {
  serial: boolean;
  mergePath: string | undefined;
  /** --focus values as given, resolved by resolveFocus. */
  focus: string[];
  testArgs: string[];
}

export function parseRunArgs(argv: readonly string[]): RunArgs {
  // Unknown options pass through, so tokens rather than values drive this.
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      serial: { type: "boolean" },
      focus: { type: "string", multiple: true },
      merge: { type: "string" },
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const args: RunArgs = {
    serial: false,
    mergePath: undefined,
    focus: [],
    testArgs: [],
  };
  for (const token of tokens) {
    if (token.kind === "positional") args.testArgs.push(token.value);
    else if (token.kind === "option-terminator") continue;
    else if (token.name === "serial") args.serial = true;
    else if (token.name === "focus") {
      if (token.value === undefined)
        throw new Error("--focus needs a src file path");
      args.focus.push(token.value);
    } else if (token.name === "merge") args.mergePath = token.value;
    else
      args.testArgs.push(
        token.inlineValue === true
          ? `${token.rawName}=${token.value}`
          : token.rawName,
      );
  }
  return args;
}

/**
 * Absolute paths of the --focus values, relative to `root`. Each must be one
 * of `sources`, since an unmatched focus would gate nothing and pass.
 */
export function resolveFocus(
  root: string,
  focus: readonly string[],
  sources: readonly string[],
): string[] {
  return focus.map((value) => {
    const path = resolve(root, value);
    if (!sources.includes(path))
      throw new Error(`--focus ${value} is not an instrumented src file`);
    return path;
  });
}

/** The entries of a saved coverage map that merge into `current`. */
export function mergeableCoverage(
  saved: CoverageMapData,
  _current: CoverageMap,
): { fresh: CoverageMapData; stale: string[] } {
  return { fresh: saved, stale: [] };
}

/** The istanbul coverage map saved at `path`. */
export function readCoverage(path: string): CoverageMapData {
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
