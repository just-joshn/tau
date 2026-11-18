import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createGlobMatcher, MAX_GLOB_PATTERN } from "../src/glob.js";
import { createTools } from "../src/tools.js";

async function fixture(t: TestContext) {
  const base = await mkdtemp(path.join(os.tmpdir(), "tau-glob-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, "root");
  await mkdir(cwd);
  const tools = createTools({ cwd, mode: "plan", approve: async () => false });
  const glob = (
    pattern: string,
    start = ".",
    signal = new AbortController().signal,
  ) =>
    tools.execute(
      {
        type: "tool_use",
        id: "glob-test",
        name: "Glob",
        input: { pattern, path: start },
      },
      signal,
    );
  const file = async (name: string) => {
    const target = path.join(cwd, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "fixture");
  };
  return { base, cwd, glob, file };
}

function strings(alphabet: string[], maxLength: number): string[] {
  const result = [""];
  let level = [""];
  for (let length = 1; length <= maxLength; length++) {
    level = level.flatMap((prefix) => alphabet.map((char) => prefix + char));
    result.push(...level);
  }
  return result;
}

// Only used with patterns/candidates of at most four string units. Unlike the
// historical regex, this oracle includes newlines in ** and requires exact EOF.
function boundedLegacyOracle(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern.charAt(i);
    if (char === "*" && pattern.charAt(i + 1) === "*") {
      i++;
      if (pattern.charAt(i + 1) === "/") {
        i++;
        source += "(?:[\\s\\S]*/)?";
      } else source += "[\\s\\S]*";
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`^(?:${source})(?![\\s\\S])`);
}

test("Glob matcher semantic matrix: wildcards, directories, and exact full strings", () => {
  const cases: Array<[string, string, boolean]> = [
    ["a", "a", true],
    ["a", "aa", false],
    ["a", "ba", false],
    ["a", "a\n", false],
    ["a", "a\r\n", false],
    ["a", "a\u2028", false],
    ["a", "", false],
    ["*", "", true],
    ["*", "abc", true],
    ["*", "a/b", false],
    ["*", "\n", true],
    ["?", "a", true],
    ["?", "", false],
    ["?", "ab", false],
    ["?", "/", false],
    ["?", "\n", true],
    ["a*b", "ab", true],
    ["a*b", "axxb", true],
    ["a*b", "a/x/b", false],
    ["**", "", true],
    ["**", "a/b\nc", true],
    ["a**b", "a/\n/b", true],
    ["**/", "", true],
    ["**/", "/", true],
    ["**/", "a/b/", true],
    ["**/", "abc", false],
    ["**/a", "a", true],
    ["**/a", "/a", true],
    ["**/a", "x/y/a", true],
    ["**/a", "xa", false],
    ["**/a", "x/a\n", false],
    ["**/a", "x\ny/a", true],
    ["src/**/a", "src/a", true],
    ["src/**/a", "src/x/y/a", true],
    ["src/**/a", "src/xa", false],
    ["a**/b", "ab", true],
    ["a**/b", "a/b", true],
    ["a**/b", "axy/b", true],
    ["a**/b", "ax/yz/b", true],
    ["a**/b", "axyb", false],
    ["**/**/a", "a", true],
    ["**/**/a", "x/y/a", true],
    ["***", "a/b", true],
    ["***/b", "b", false],
    ["***/b", "a/b", true],
    ["****/b", "b", true],
    ["a?b", "a/b", false],
    ["a?b", "a\nb", true],
  ];
  for (const [pattern, candidate, expected] of cases) {
    assert.equal(
      createGlobMatcher(pattern)(candidate),
      expected,
      JSON.stringify({ pattern, candidate }),
    );
  }
});

test("Glob treats regex punctuation and backslashes literally", () => {
  for (const literal of [
    ".",
    "+",
    "^",
    "$",
    "(",
    ")",
    "[",
    "]",
    "{",
    "}",
    "|",
    "\\",
    "a.b+[c](d){2}^$|\\",
  ]) {
    const matches = createGlobMatcher(literal);
    assert.equal(matches(literal), true, JSON.stringify(literal));
    assert.equal(matches(`${literal}\n`), false, JSON.stringify(literal));
    assert.equal(matches(`x${literal}`), false, JSON.stringify(literal));
  }
  assert.equal(createGlobMatcher("[ab]")("a"), false);
  assert.equal(createGlobMatcher("{a,b}")("a"), false);
  assert.equal(createGlobMatcher("a|b")("b"), false);
  assert.equal(createGlobMatcher("a\\b")("a/b"), false);
  assert.equal(createGlobMatcher("\\*")("\\abc"), true);
  assert.equal(createGlobMatcher("\\*")("*"), false);
});

test("Glob uses UTF-16 units without normalization and matches newline names", () => {
  const cases: Array<[string, string, boolean]> = [
    ["?", "é", true],
    ["?", "😀", false],
    ["??", "😀", true],
    ["?", "\ud800", true],
    ["?", "\udc00", true],
    ["é", "e\u0301", false],
    ["??", "e\u0301", true],
    ["😀", "😀", true],
    ["*", "😀", true],
    ["**/😀", "目录/😀", true],
    ["目录/?", "目录/字", true],
    ["line\nbreak", "line\nbreak", true],
    ["**/name", "dir\nname/name", true],
    ["**", "\r\n\u2028\u2029/", true],
    ["*.ts", "line\nbreak.ts", true],
  ];
  for (const [pattern, candidate, expected] of cases) {
    assert.equal(
      createGlobMatcher(pattern)(candidate),
      expected,
      JSON.stringify({ pattern, candidate }),
    );
  }
});

test("Glob exhaustively agrees with a bounded independent legacy-grammar regex oracle", () => {
  const patterns = strings(["a", "/", "*", "?"], 4).filter(Boolean);
  const candidates = strings(["a", "b", "/", "\n"], 4);
  let comparisons = 0;
  for (const pattern of patterns) {
    const oracle = boundedLegacyOracle(pattern);
    const matches = createGlobMatcher(pattern);
    for (const candidate of candidates) {
      assert.equal(
        matches(candidate),
        oracle.test(candidate),
        JSON.stringify({ pattern, candidate }),
      );
      comparisons++;
    }
  }
  assert.equal(comparisons, 115940);
});

test("Glob validates its 1024 UTF-16-unit pattern bound", () => {
  assert.equal(MAX_GLOB_PATTERN, 1024);
  assert.throws(() => createGlobMatcher(""), /pattern.*1.*1024/i);
  for (const pattern of ["a".repeat(1025), "😀".repeat(513)]) {
    assert.throws(() => createGlobMatcher(pattern), /pattern.*1024/i);
  }
  for (const pattern of ["a".repeat(1024), "😀".repeat(512)]) {
    assert.equal(createGlobMatcher(pattern)(pattern), true);
  }
});

test("Glob shares exactly 10,000,000 state/candidate cells across a query", () => {
  const pattern = "a".repeat(999);
  for (const [candidate, expected] of [
    [pattern, true],
    ["b".repeat(999), false],
  ] satisfies Array<[string, boolean]>) {
    const matches = createGlobMatcher(pattern);
    // 1000 states * 1000 candidate positions = 1,000,000 cells per call.
    for (let call = 0; call < 10; call++)
      assert.equal(matches(candidate), expected);
    assert.throws(
      () => matches(candidate),
      /Glob matching work limit exceeded/,
    );
    assert.equal(createGlobMatcher(pattern)(candidate), expected);
  }
});

test("Glob rejects a single candidate above its work limit with an explicit error", () => {
  const matches = createGlobMatcher("a".repeat(MAX_GLOB_PATTERN));
  assert.throws(
    () => matches("a".repeat(10000)),
    /Glob matching work limit exceeded.*narrow/i,
  );
});

test("Glob dispatch searches a real workspace, scopes paths, and skips excluded trees and symlinks", async (t) => {
  const { base, cwd, glob, file } = await fixture(t);
  const visible = [
    "root.ts",
    ".hidden.ts",
    "literal[1].ts",
    "nested/child.ts",
    "nested/deep/end.ts",
  ];
  for (const name of [...visible, "readme.md"]) await file(name);
  for (const dir of [
    ".git",
    "node_modules",
    ".tau",
    "nested/.git",
    "nested/node_modules",
    "nested/.tau",
  ]) {
    await file(`${dir}/excluded.ts`);
  }
  const outside = path.join(base, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.ts"), "outside");
  await symlink(outside, path.join(cwd, "escape"));
  await symlink(
    path.join(outside, "secret.ts"),
    path.join(cwd, "secret-link.ts"),
  );
  await symlink(path.join(cwd, "nested"), path.join(cwd, "inside-link"));

  const all = await glob("**/*.ts");
  assert.equal(all.is_error, undefined);
  assert.deepEqual(all.content.split("\n").sort(), visible.sort());
  const top = await glob("*.ts");
  assert.equal(top.is_error, undefined);
  assert.deepEqual(top.content.split("\n").sort(), [
    ".hidden.ts",
    "literal[1].ts",
    "root.ts",
  ]);
  const scoped = await glob("**/*.ts", "nested");
  assert.equal(scoped.is_error, undefined);
  assert.deepEqual(scoped.content.split("\n").sort(), [
    "nested/child.ts",
    "nested/deep/end.ts",
  ]);
  assert.equal((await glob("literal[1].ts")).content, "literal[1].ts");
  assert.equal((await glob("absent*")).content, "");

  for (const start of [
    "..",
    outside,
    "escape",
    "escape/secret.ts",
    "secret-link.ts",
  ]) {
    const result = await glob("**", start);
    assert.equal(result.is_error, true, start);
    assert.match(result.content, /escapes workspace root/i, start);
  }
  for (const start of [".git", "node_modules", ".tau", "nested/node_modules"]) {
    const result = await glob("**", start);
    assert.equal(result.is_error, true, start);
    assert.match(result.content, /excluded/i, start);
  }
});

test("Glob dispatch preserves exact matching and newline directory/file names", async (t) => {
  const { glob, file } = await fixture(t);
  await file("name");
  await file("name\n");
  await file("line\nbreak.ts");
  await file("dir\nname/child.ts");
  assert.equal((await glob("name")).content, "name");
  assert.equal((await glob("name\n")).content, "name\n");
  assert.equal((await glob("*.ts")).content, "line\nbreak.ts");
  assert.equal((await glob("**/child.ts")).content, "dir\nname/child.ts");
});

test("Glob dispatch surfaces oversize patterns and already-aborted signals as tool errors", async (t) => {
  const { glob } = await fixture(t);
  for (const pattern of ["a".repeat(MAX_GLOB_PATTERN + 1), "😀".repeat(513)]) {
    const result = await glob(pattern);
    assert.equal(result.is_error, true);
    assert.match(result.content, /1024/);
  }
  assert.equal((await glob("")).is_error, true);
  const controller = new AbortController();
  controller.abort(new Error("Glob cancelled before dispatch"));
  const cancelled = await glob("**", ".", controller.signal);
  assert.equal(cancelled.is_error, true);
  assert.equal(cancelled.content, "Glob cancelled before dispatch");
});

test("Glob dispatch shares its matcher work limit across workspace files", async (t) => {
  const { glob, file } = await fixture(t);
  for (let i = 0; i < 50; i++)
    await file(`${String(i).padStart(3, "0")}-${"a".repeat(196)}`);
  const result = await glob("a".repeat(MAX_GLOB_PATTERN));
  assert.equal(result.is_error, true);
  assert.match(result.content, /Glob matching work limit exceeded/);
  const fresh = await glob("*");
  assert.equal(fresh.is_error, undefined);
  assert.equal(fresh.content.split("\n").length, 50);
});

test("Glob pathological wildcard dispatch completes normally in an isolated compiled child", async (t) => {
  const { cwd, file } = await fixture(t);
  await file("a".repeat(40));
  const toolsURL = new URL("../src/tools.js", import.meta.url).href;
  const source = `import { createTools } from ${JSON.stringify(toolsURL)};
const tools = createTools({ cwd: ${JSON.stringify(cwd)}, mode: "plan", approve: async () => false });
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 500);
try {
  const result = await tools.execute({
    type: "tool_use", id: "regression", name: "Glob", input: { pattern: "*a".repeat(30) + "b" }
  }, controller.signal);
  process.stdout.write(JSON.stringify({ result, aborted: controller.signal.aborted }));
} finally { clearTimeout(timer); }
`;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source],
    {
      cwd,
      encoding: "utf8",
      timeout: 2500,
    },
  );
  assert.equal(
    child.error,
    undefined,
    `Child failed or timed out: ${child.error?.message}; ${child.stderr}`,
  );
  assert.equal(
    child.signal,
    null,
    `Child was externally killed: ${child.signal}; ${child.stderr}`,
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  const output: unknown = JSON.parse(child.stdout);
  assert.deepEqual(output, {
    result: { type: "tool_result", tool_use_id: "regression", content: "" },
    aborted: false,
  });
});
