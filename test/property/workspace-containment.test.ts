import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "bun:test";
import { createTools } from "../../src/tools.js";
import { forAll, type Rng } from "../helpers/seeded.js";

// INV-06: file tools stay inside the working directory. The oracle is the
// lexical one: resolve the requested path against the workspace root and
// check whether the result is the root or below it. No symlinks exist in
// this workspace, so the canonical and lexical answers must agree.

const CASES = 400;

interface Layout {
  base: string;
  root: string;
}

async function layout(): Promise<Layout> {
  const base = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "tau-prop-path-")),
  );
  onTestFinished(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "root");
  await mkdir(path.join(root, "a", "b"), { recursive: true });
  await mkdir(path.join(base, "sibling"));
  await writeFile(path.join(root, "a", "file.txt"), "inside\n");
  await writeFile(path.join(base, "secret.txt"), "outside\n");
  await writeFile(path.join(base, "sibling", "file.txt"), "outside\n");
  return { base, root };
}

function generate(rng: Rng, { base, root }: Layout): string {
  const segments = [
    "a",
    "b",
    "file.txt",
    "secret.txt",
    "sibling",
    "root",
    "..",
    "..",
    ".",
    "",
    "ü",
    "é",
    "日本",
    "with space",
    "..x",
    "x..",
    "...",
  ];
  const body = Array.from({ length: rng.int(1, 7) }, () => rng.pick(segments))
    .map((segment) => segment + "/".repeat(rng.int(0, 2)))
    .join(rng.pick(["/", "//", "/./"]));
  const prefix = rng.pick([
    "",
    "",
    "./",
    "../",
    `${root}/`,
    `${root}//`,
    `${base}/`,
    "/",
    `${path.dirname(base)}/`,
  ]);
  const candidate = (prefix + body).replace(/^$/, ".");
  return rng.bool(0.15) ? candidate.replace(/\/+$/, "") || "." : candidate;
}

function inside(root: string, requested: string): boolean {
  const relative = path.relative(root, path.resolve(root, requested));
  return !(
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}

test("INV-06 file tool containment agrees with a path.resolve oracle for generated paths", async () => {
  const where = await layout();
  const tools = createTools({
    cwd: where.root,
    mode: "bypassPermissions",
    approve: async () => true,
  });
  const signal = new AbortController().signal;
  const counts = { inside: 0, outside: 0 };
  await forAll(
    "workspace containment",
    CASES,
    (rng) => generate(rng, where),
    async (requested, index) => {
      const expected = inside(where.root, requested);
      counts[expected ? "inside" : "outside"]++;
      for (const [name, input] of [
        ["Read", { file_path: requested }],
        ["Glob", { pattern: "*", path: requested }],
      ] as const) {
        const result = await tools.execute(
          { type: "tool_use", id: `c${index}`, name, input },
          signal,
        );
        assert.equal(
          result.permissionDenied === true,
          !expected,
          `${name} ${expected ? "denied an inside" : "allowed an outside"} path: ${JSON.stringify(result.content)}`,
        );
        if (!expected) assert.doesNotMatch(String(result.content), /outside\n/);
      }
    },
  );
  assert.ok(counts.inside > CASES / 5, `only ${counts.inside} inside`);
  assert.ok(counts.outside > CASES / 5, `only ${counts.outside} outside`);
});
