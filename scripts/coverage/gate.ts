import type { CoverageMap, CoverageMapData } from "istanbul-lib-coverage";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

export interface RunArgs {
  serial: boolean;
  mergePath: string | undefined;
  focus: string[];
  testArgs: string[];
}

export function parseRunArgs(argv: readonly string[]): RunArgs {
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

/**
 * Splits a saved coverage map into the entries whose statement, function and
 * branch maps match `current`, and the paths of the rest. istanbul merges by
 * location, so a stale entry would add its locations to the totals.
 */
export function mergeableCoverage(
  saved: CoverageMapData,
  current: CoverageMap,
): { fresh: CoverageMapData; stale: string[] } {
  const fresh: CoverageMapData = {};
  const stale: string[] = [];
  const files = new Set(current.files());
  for (const [path, entry] of Object.entries(saved)) {
    const now = files.has(path) ? current.fileCoverageFor(path) : undefined;
    if (
      now !== undefined &&
      Bun.deepEquals(
        [entry.statementMap, entry.fnMap, entry.branchMap],
        [now.statementMap, now.fnMap, now.branchMap],
      )
    )
      fresh[path] = entry;
    else stale.push(path);
  }
  return { fresh, stale };
}

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
