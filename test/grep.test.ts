import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { grepInputSchema, searchText } from "../src/grep.js";
import { createTools } from "../src/tools.js";

async function workspace(t: TestContext) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "tau-grep-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const tools = createTools({ cwd, mode: "plan", approve: async () => false });
  const run = (
    input: Record<string, unknown>,
    signal = new AbortController().signal,
  ) =>
    tools.execute(
      { type: "tool_use", id: "grep", name: "Grep", input },
      signal,
    );
  return { cwd, run };
}

test("Grep defaults to regex file results sorted by mtime, then name, before pagination", async (t) => {
  const { cwd, run } = await workspace(t);
  for (const [name, time] of [
    ["a.ts", 1],
    ["b.ts", 2],
    ["c.ts", 2],
  ] satisfies Array<[string, number]>) {
    await writeFile(path.join(cwd, name), "cat cat\ncat\nCat\n");
    await utimes(path.join(cwd, name), time, time);
  }
  assert.equal((await run({ pattern: "^cat$" })).content, "b.ts\nc.ts\na.ts");
  assert.equal(
    (await run({ pattern: "^cat$", offset: 1, head_limit: 1 })).content,
    "c.ts\n[more results: limit 1, offset 1]",
  );
  assert.equal(
    (await run({ pattern: "cat", output_mode: "count", path: "a.ts" })).content,
    "a.ts:2",
  );
  assert.equal(
    (
      await run({
        pattern: "cat",
        output_mode: "count",
        path: "a.ts",
        "-i": true,
      })
    ).content,
    "a.ts:3",
  );
});

test("Grep content has single-file/directory prefixes and explicit case/line-number control", async (t) => {
  const { cwd, run } = await workspace(t);
  await writeFile(path.join(cwd, "a.txt"), "Cat\ncat cat\nother\n");
  assert.equal(
    (await run({ pattern: "^cat", output_mode: "content" })).content,
    "a.txt:2:cat cat",
  );
  assert.equal(
    (
      await run({
        pattern: "^cat",
        path: "a.txt",
        output_mode: "content",
        "-i": true,
      })
    ).content,
    "1:Cat\n2:cat cat",
  );
  assert.equal(
    (await run({ pattern: "^cat", output_mode: "content", "-n": false }))
      .content,
    "a.txt:cat cat",
  );
  assert.equal(
    (
      await run({
        pattern: "^cat",
        path: "a.txt",
        output_mode: "content",
        "-n": false,
      })
    ).content,
    "cat cat",
  );
  await writeFile(path.join(cwd, "empty-line"), "\n");
  assert.equal(
    (
      await run({
        pattern: "^$",
        path: "empty-line",
        output_mode: "content",
        "-n": false,
      })
    ).content,
    "",
  );
});

test("Grep pagination defaults to 250, zero removes page limit, offset applies first", async (t) => {
  const { cwd, run } = await workspace(t);
  await writeFile(path.join(cwd, "a"), "hit\n".repeat(260));
  const defaults = await run({
    pattern: "hit",
    path: "a",
    output_mode: "content",
  });
  assert.equal(defaults.content.split("\n").length, 251);
  assert.match(
    defaults.content,
    /250:hit\n\[more results: limit 250, offset 0\]$/,
  );
  assert.equal(
    (
      await run({
        pattern: "hit",
        path: "a",
        output_mode: "content",
        offset: 5,
        head_limit: 2,
      })
    ).content,
    "6:hit\n7:hit\n[more results: limit 2, offset 5]",
  );
  const unlimited = await run({
    pattern: "hit",
    path: "a",
    output_mode: "content",
    head_limit: 0,
  });
  assert.equal(unlimited.content.split("\n").length, 260);
  assert.equal(
    (await run({ pattern: "hit", offset: 2 })).content,
    "No entries at this offset",
  );
});

test("Grep rejects unknown options and unsupported filters instead of silently ignoring them", async (t) => {
  const { cwd, run } = await workspace(t);
  await writeFile(path.join(cwd, "a.ts"), "hit");
  for (const extra of [
    { multiline: true },
    { context: 1 },
    { "-o": true },
    { type: "ts" },
    { glob: "*.ts" },
    { glob: "*.{ts,js}" },
    { glob: "*.ts,*.js" },
    { glob: "*a".repeat(30) + "b" },
    { head_limit: -1 },
    { offset: 0.5 },
    { "-i": "true" },
    { unknown: true },
  ])
    assert.equal((await run({ pattern: "hit", ...extra })).is_error, true);
});

test("Grep distinguishes no matches, invalid regex including on empty trees, and unreadable paths", async (t) => {
  const { cwd, run } = await workspace(t);
  assert.equal((await run({ pattern: "none" })).content, "No files found");
  for (const pattern of ["[", "(?=x)", "(x)\\1"]) {
    const result = await run({ pattern });
    assert.equal(result.is_error, true);
    assert.match(result.content, /Grep backend failed/);
  }
  assert.equal((await run({ pattern: "x", path: "absent" })).is_error, true);
  for (const field of ["pattern", "path", "glob"]) {
    assert.equal((await run({ pattern: "x", [field]: "x\0x" })).is_error, true);
  }
  await writeFile(path.join(cwd, "a"), "--pre=not-a-command\n");
  assert.equal((await run({ pattern: "--pre=not-a-command" })).content, "a");
});

test("Grep never searches its truncation marker, warns on prefixes, skips binaries and symlinks", async (t) => {
  const { cwd, run } = await workspace(t);
  await writeFile(path.join(cwd, "large"), "x".repeat(65536) + "secret-tail");
  await writeFile(path.join(cwd, "binary"), "binary-hit\0");
  await symlink(os.tmpdir(), path.join(cwd, "link"));
  for (const pattern of ["secret-tail", "output truncated", "binary-hit"]) {
    const result = await run({ pattern });
    assert.equal(result.is_error, undefined);
    assert.match(result.content, /^No files found\n\[search incomplete:/);
  }
  assert.equal((await run({ pattern: "x", path: "link" })).is_error, true);
  const output = await run({ pattern: "x", output_mode: "content" });
  assert.ok(Buffer.byteLength(output.content) < 66000);
  assert.match(output.content, /\[output truncated\]$/);
});

async function backend(t: TestContext, code: string) {
  const { cwd } = await workspace(t);
  const executable = path.join(cwd, "rg.cjs");
  await writeFile(executable, `#!${process.execPath}\n${code}`, {
    mode: 0o700,
  });
  return (signal = new AbortController().signal, timeout = 2000) =>
    searchText({
      executable,
      input: grepInputSchema.parse({ pattern: "x", output_mode: "content" }),
      text: "x".repeat(65536),
      signal,
      timeout,
    });
}

test("Grep backend drains stdout, treats exit 1 as no-match, and isolates environment", async (t) => {
  const large = await backend(
    t,
    'process.stdin.resume(); process.stdout.write("x".repeat(300000));',
  );
  assert.equal((await large()).output.length, 300000);
  const absent = await backend(
    t,
    "process.stdin.resume(); process.exitCode = 1;",
  );
  assert.deepEqual(await absent(), { matched: false, output: "" });
  const env = await backend(
    t,
    'process.stdin.resume(); process.stdout.write(Object.keys(process.env).join(","));',
  );
  const keys = (await env()).output
    .split(",")
    .filter((key) => key !== "__CF_USER_TEXT_ENCODING");
  assert.deepEqual(keys, ["LC_ALL"]);
  const bad = await backend(
    t,
    'process.stderr.write("invalid pattern"); process.exitCode = 2;',
  );
  await assert.rejects(bad(), /exit 2.*invalid pattern/);
});

test("Grep backend aborts, timeouts and excessive output terminate promptly", async (t) => {
  const hanging = await backend(
    t,
    "process.stdin.resume(); setInterval(() => {}, 1000);",
  );
  const start = Date.now();
  await assert.rejects(hanging(undefined, 30), /timed out/);
  const controller = new AbortController();
  const pending = hanging(controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, /aborted/);
  const cancelled = new AbortController();
  cancelled.abort();
  assert.throws(() => hanging(cancelled.signal), /abort/i);
  const huge = await backend(
    t,
    'process.stdin.resume(); process.stdout.write("x".repeat(600000));',
  );
  await assert.rejects(huge(), /output limit/);
  assert.ok(Date.now() - start < 3000);
});

test("Grep requires standalone rg and rejects relative PATH entries instead of running workspace programs", async (t) => {
  const { cwd } = await workspace(t);
  const marker = path.join(cwd, "ran");
  await writeFile(
    path.join(cwd, "rg"),
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad");`,
    { mode: 0o700 },
  );
  const modulePath = fileURLToPath(new URL("../src/grep.js", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { findRipgrep } from ${JSON.stringify(modulePath)}; await findRipgrep();`,
    ],
    { cwd, env: { PATH: "." }, encoding: "utf8", timeout: 3000 },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires standalone ripgrep/);
  const check = spawnSync(process.execPath, [
    "-e",
    `process.exit(require("node:fs").existsSync(${JSON.stringify(marker)}) ? 1 : 0)`,
  ]);
  assert.equal(check.status, 0);
});
