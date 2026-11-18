import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "bun:test";
import { findRipgrep, grepInputSchema, searchText } from "../../src/grep.js";

async function scratch() {
  const dir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "tau-grep-edges-")),
  );
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function search(executable: string, timeout = 2000) {
  return searchText({
    executable,
    input: grepInputSchema.parse({ pattern: "x" }),
    text: "x\n",
    signal: new AbortController().signal,
    timeout,
  });
}

test("findRipgrep skips relative entries and rg directories, then returns the first executable rg file", async () => {
  const dir = await scratch();
  await mkdir(path.join(dir, "dir-entry", "rg"), { recursive: true });
  await mkdir(path.join(dir, "bin"));
  const rg = path.join(dir, "bin", "rg");
  await writeFile(rg, "#!/bin/sh\n", { mode: 0o700 });
  await mkdir(path.join(dir, "linked"));
  await symlink(rg, path.join(dir, "linked", "rg"));
  process.env.PATH = [
    ".",
    path.join(dir, "dir-entry"),
    path.join(dir, "linked"),
  ].join(path.delimiter);
  assert.equal(await findRipgrep(), rg);
});

test("findRipgrep fails closed with no PATH at all", async () => {
  delete process.env.PATH;
  await assert.rejects(findRipgrep(), /requires standalone ripgrep/);
});

test("findRipgrep surfaces unexpected filesystem errors instead of skipping the entry", async () => {
  const dir = await scratch();
  // A self-referential symlink makes realpath fail with ELOOP.
  await symlink(path.join(dir, "rg"), path.join(dir, "rg"));
  process.env.PATH = dir;
  await assert.rejects(findRipgrep(), (error: unknown) => {
    assert.ok(error instanceof Error && "code" in error);
    assert.equal(error.code, "ELOOP");
    return true;
  });
});

test("searchText with an exhausted timeout rejects without starting rg", async () => {
  const dir = await scratch();
  const marker = path.join(dir, "ran");
  const executable = path.join(dir, "rg.cjs");
  await writeFile(
    executable,
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`,
    { mode: 0o700 },
  );
  await assert.rejects(search(executable, 0), /timed out/);
  assert.equal(existsSync(marker), false);
});

test("searchText rejects with the spawn error when rg cannot be started", async () => {
  const dir = await scratch();
  await assert.rejects(search(path.join(dir, "missing")), (error: unknown) => {
    assert.ok(error instanceof Error && "code" in error);
    assert.equal(error.code, "ENOENT");
    return true;
  });
});

test("searchText keeps the result of an rg that exits before reading all input", async () => {
  const dir = await scratch();
  const executable = path.join(dir, "rg.cjs");
  await writeFile(
    executable,
    `#!${process.execPath}\nprocess.stdout.write("1:x\\n"); process.exit(0);`,
    { mode: 0o700 },
  );
  const result = await searchText({
    executable,
    input: grepInputSchema.parse({ pattern: "x", output_mode: "content" }),
    text: "x\n".repeat(1 << 20),
    signal: new AbortController().signal,
    timeout: 5000,
  });
  assert.deepEqual(result, { matched: true, output: "1:x\n" });
});
