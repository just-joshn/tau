import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, lstat, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createTools } from "../src/tools.js";
import { ReadState } from "../src/read-state.js";
import type { ToolPolicy } from "../src/tool-policy.js";
import type { PermissionMode } from "../src/types.js";

async function fixture(t: TestContext) {
  const base = await mkdtemp(path.join(os.tmpdir(), "tau-tools-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, "root"); await mkdir(cwd);
  const approvals: string[] = [];
  const readState = new ReadState();
  const tools = (mode: PermissionMode = "bypassPermissions", allowed = true, policy?: ToolPolicy) => createTools({ cwd, mode, readState, ...(policy ? { policy } : {}), approve: async description => { approvals.push(description); return allowed; } });
  const run = (executor: ReturnType<typeof createTools>, name: string, input: Record<string, unknown>, signal = new AbortController().signal) => executor.execute({ type: "tool_use", id: "test", name, input }, signal);
  return { base, cwd, tools, run, approvals };
}

test("filesystem bounds include symlinks and missing parents in bypass mode", async t => {
  const { base, cwd, tools, run } = await fixture(t);
  await writeFile(path.join(base, "secret"), "secret");
  await symlink(base, path.join(cwd, "escape"));
  for (const file_path of ["../secret", path.join(base, "secret"), "escape/secret", "escape/new/deep/file", ".git/config"]) {
    assert.equal((await run(tools(), "Read", { file_path })).is_error, true);
    assert.equal((await run(tools(), "Write", { file_path, content: "bad" })).is_error, true);
  }
  assert.equal(await readFile(path.join(base, "secret"), "utf8"), "secret");
  assert.equal((await run(tools(), "Write", { file_path: "new/deep/file", content: "ok" })).is_error, undefined);
});

test("permission modes gate edits and unsandboxed Bash", async t => {
  const { tools, run, approvals } = await fixture(t);
  assert.equal((await run(tools("default", false), "Write", { file_path: "a", content: "a" })).is_error, true);
  assert.equal((await run(tools("acceptEdits", false), "Write", { file_path: "a", content: "a" })).is_error, undefined);
  assert.equal((await run(tools("default", false), "Read", { file_path: "a" })).content, "1\ta");
  assert.equal((await run(tools("plan"), "Write", { file_path: "a", content: "b" })).is_error, true);
  assert.equal((await run(tools("plan"), "Bash", { command: "echo no" })).is_error, true);
  assert.equal((await run(tools("acceptEdits", false), "Bash", { command: "echo no" })).is_error, true);
  assert.match(approvals.at(-1) ?? "", /NOT sandboxed/);
  assert.match((await run(tools("default"), "Bash", { command: "printf yes" })).content, /yes/);
});

test("policy availability and denial override every permission mode", async t => {
  const { tools, run, approvals } = await fixture(t);
  for (const mode of ["default", "acceptEdits", "plan", "bypassPermissions"] satisfies PermissionMode[]) {
    const executor = tools(mode, true, { allowedTools: ["Write", "Bash"], disallowedTools: ["Write", "Bash", "Read"] });
    assert.deepEqual(executor.definitions.map(tool => tool.name), ["Edit", "Glob", "Grep"]);
    for (const name of ["Write", "Bash", "Read"]) {
      assert.match((await run(executor, name, {})).content, /disabled or denied/);
    }
  }
  const empty = tools("bypassPermissions", true, { tools: [], allowedTools: ["Bash"], disallowedTools: [] });
  assert.deepEqual(empty.definitions, []);
  assert.match((await run(empty, "Bash", { command: "printf no" })).content, /disabled or denied/);
  assert.deepEqual(approvals, []);
});

test("explicit allow preapproves existing tools but cannot bypass plan or availability", async t => {
  const { tools, run, approvals, cwd } = await fixture(t);
  const policy: ToolPolicy = { allowedTools: ["Write", "Edit", "Bash"], disallowedTools: [] };
  const executor = tools("default", false, policy);
  assert.equal((await run(executor, "Write", { file_path: "a", content: "one" })).is_error, undefined);
  assert.equal((await run(executor, "Edit", { file_path: "a", old_string: "one", new_string: "two" })).is_error, undefined);
  assert.match((await run(executor, "Bash", { command: "printf allowed" })).content, /allowed/);
  for (const [name, input] of [
    ["Write", { file_path: "a", content: "no" }],
    ["Edit", { file_path: "a", old_string: "two", new_string: "no" }],
    ["Bash", { command: "printf no" }],
  ] satisfies Array<[string, Record<string, unknown>]>) {
    assert.match((await run(tools("plan", false, policy), name, input)).content, /Plan mode/);
  }
  const limited = tools("default", false, { ...policy, tools: ["Read"] });
  assert.deepEqual(limited.definitions.map(tool => tool.name), ["Read"]);
  assert.match((await run(limited, "Write", { file_path: "a", content: "no" })).content, /disabled or denied/);
  assert.equal(await readFile(path.join(cwd, "a"), "utf8"), "two");
  assert.deepEqual(approvals, []);
});

test("Edit requires a unique nonempty exact match", async t => {
  const { cwd, tools, run } = await fixture(t);
  await writeFile(path.join(cwd, "a"), "one one");
  await run(tools(), "Read", { file_path: "a" });
  for (const old_string of ["", "one", "absent"]) assert.equal((await run(tools(), "Edit", { file_path: "a", old_string, new_string: "x" })).is_error, true);
  assert.equal((await run(tools(), "Edit", { file_path: "a", old_string: "one one", new_string: "two" })).is_error, undefined);
  assert.equal(await readFile(path.join(cwd, "a"), "utf8"), "two");
});

test("searches skip excluded trees and symlinks and bound reads", async t => {
  const { cwd, base, tools, run } = await fixture(t);
  await mkdir(path.join(cwd, "nested")); await writeFile(path.join(cwd, "nested/a.ts"), "needle\nother");
  for (const dir of [".git", "node_modules", ".tau"]) { await mkdir(path.join(cwd, dir)); await writeFile(path.join(cwd, dir, "hidden.ts"), "needle"); }
  await writeFile(path.join(base, "outside.ts"), "needle"); await symlink(base, path.join(cwd, "link"));
  assert.equal((await run(tools(), "Glob", { pattern: "**/*.ts" })).content, "nested/a.ts");
  assert.equal((await run(tools(), "Grep", { pattern: "needle", output_mode: "content" })).content, "nested/a.ts:1:needle");
  await writeFile(path.join(cwd, "large"), "x".repeat(100004));
  assert.match((await run(tools(), "Read", { file_path: "large" })).content, /truncated/);
});

test("approval descriptions show bounded proposed Write and Edit content", async t => {
  const { tools, run, approvals, cwd } = await fixture(t);
  await run(tools("default", false), "Write", { file_path: "a", content: "proposed text" });
  assert.match(approvals.at(-1) ?? "", /Proposed content:\nproposed text/);
  // A valid existing-file edit reaches approval only after its Read prerequisite.
  await writeFile(path.join(cwd, "a"), "before");
  await run(tools("default", false), "Read", { file_path: "a" });
  await run(tools("default", false), "Edit", { file_path: "a", old_string: "before", new_string: "after" });
  assert.match(approvals.at(-1) ?? "", /Replace:\nbefore\nWith:\nafter/);
  await run(tools("default", false), "Write", { file_path: "a", content: "x".repeat(100004) });
  assert.match(approvals.at(-1) ?? "", /\[output truncated\]$/);
  assert.ok((approvals.at(-1) ?? "").length < 66000);
});

test("Glob rejects NUL inputs, unsupported fields and non-directory search roots", async t => {
  const { cwd, tools, run } = await fixture(t);
  await writeFile(path.join(cwd, "a.txt"), "fixture");
  for (const input of [
    { pattern: "x\0x" }, { pattern: "*", path: "x\0x" },
    { pattern: "*", head_limit: 1 }, { pattern: "*", path: "a.txt" },
  ]) assert.equal((await run(tools(), "Glob", input)).is_error, true);
  assert.equal((await run(tools(), "Glob", { pattern: "*.txt" })).content, "a.txt");
});

test("Bash drains large bounded output and preserves nonzero status", async t => {
  const { tools, run } = await fixture(t);
  for (let attempt = 0; attempt < 20; attempt++) {
    const length = 40000 + Math.floor(Math.random() * 20000);
    const expected = "x".repeat(length);
    const result = await run(tools(), "Bash", {
      command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write("x".repeat(${length}))'`,
    });
    assert.equal(result.content, `${expected}\n[exit 0]`);
    assert.equal(result.is_error, undefined);
  }
  const failed = await run(tools(), "Bash", { command: "printf failure; exit 7" });
  assert.equal(failed.content, "failure\n[exit 7]");
  assert.equal(failed.is_error, true);
});

test("Bash timeouts and aborts return promptly even with inherited pipes", async t => {
  const { tools, run } = await fixture(t);
  const start = Date.now();
  assert.match((await run(tools(), "Bash", { command: "sleep 30", timeout: 50 })).content, /timed out/);
  const controller = new AbortController();
  const pending = run(tools(), "Bash", { command: "sleep 30" }, controller.signal);
  setTimeout(() => controller.abort(), 50);
  assert.match((await pending).content, /aborted/);
  const inherited = await run(tools(), "Bash", {
    command: `${JSON.stringify(process.execPath)} -e 'require("node:child_process").spawn("sleep", ["30"], {stdio: "inherit"}); process.exit(0)'`,
    timeout: 1000,
  });
  assert.equal(inherited.is_error, undefined);
  assert.ok(Date.now() - start < 3000);
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal((await run(tools(), "Write", { file_path: "no", content: "no" }, cancelled.signal)).is_error, true);
});

test("bounded UTF-8 output truncates without replacement chars across tools", async t => {
  const { cwd, tools, run, approvals } = await fixture(t);
  const euro = "€";
  const maxOut = 65536 + Buffer.byteLength("\n[output truncated]");
  const assertBounded = (text: string, label: string) => {
    assert.ok(!text.includes("\uFFFD"), `${label} must not invent U+FFFD`);
    assert.ok(Buffer.byteLength(text, "utf8") <= maxOut, `${label} must stay within ${maxOut} bytes`);
    assert.equal(Buffer.from(text, "utf8").toString("utf8"), text, `${label} must be valid UTF-8`);
  };

  const grepPath = "utf8-euros.txt";
  await writeFile(path.join(cwd, grepPath), euro.repeat(21845), "utf8");
  assert.equal(Buffer.byteLength(euro.repeat(21845), "utf8"), 65535);
  const grep = await run(tools(), "Grep", { pattern: euro, output_mode: "content", path: grepPath });
  assert.equal(grep.is_error, undefined);
  assertBounded(grep.content, "Grep");
  assert.match(grep.content, /\[output truncated\]$/);

  const namesDir = path.join(cwd, "unicode-names");
  await mkdir(namesDir);
  const base = euro.repeat(50);
  for (let batch = 0; batch < 10; batch++) {
    await Promise.all(
      Array.from({ length: 50 }, (_, j) => {
        const i = batch * 50 + j;
        return writeFile(path.join(namesDir, `${base}-${String(i).padStart(3, "0")}.txt`), "", "utf8");
      }),
    );
  }
  const glob = await run(tools(), "Glob", { pattern: "*.txt", path: "unicode-names" });
  assert.equal(glob.is_error, undefined);
  assertBounded(glob.content, "Glob");
  assert.match(glob.content, /\[output truncated\]$/);

  const executor = tools("default", false);
  const bomContent = "\uFEFF" + euro.repeat(30_000);
  await run(executor, "Write", { file_path: "bom-proposal.txt", content: bomContent });
  const writeApproval = approvals.at(-1) ?? "";
  const proposed = writeApproval.slice(writeApproval.indexOf("Proposed content:\n") + "Proposed content:\n".length);
  assert.ok(proposed.startsWith("\uFEFF"), "Write approval must preserve BOM in proposed preview");
  assertBounded(proposed, "Write proposed preview");
  assert.match(proposed, /\[output truncated\]$/);

  const longReplace = euro.repeat(30_000);
  await writeFile(path.join(cwd, "edit-preview.txt"), "needle");
  await run(executor, "Read", { file_path: "edit-preview.txt" });
  await run(executor, "Edit", { file_path: "edit-preview.txt", old_string: "needle", new_string: longReplace });
  const editApproval = approvals.at(-1) ?? "";
  const editBounded = editApproval.slice(editApproval.indexOf("\n") + 1);
  assertBounded(editBounded, "Edit approval preview");
  assert.match(editBounded, /With:\n/);
  assert.match(editBounded, /\[output truncated\]$/);
});

const leftovers = async (dir: string) => (await readdir(dir)).filter(name => name.includes(".tmp."));

test("Edit supports replace_all and publishes it as an optional input", async t => {
  const { cwd, tools, run } = await fixture(t);
  await writeFile(path.join(cwd, "a"), "x x x");
  await run(tools(), "Read", { file_path: "a" });
  const edit = (replace_all?: boolean) => run(tools(), "Edit", { file_path: "a", old_string: "x", new_string: "y", ...(replace_all === undefined ? {} : { replace_all }) });
  const refused = await edit();
  assert.equal(refused.is_error, true);
  assert.match(String(refused.content), /^Found 3 matches of the string to replace, but replace_all is false\./);
  assert.equal(await readFile(path.join(cwd, "a"), "utf8"), "x x x");
  assert.equal((await edit(false)).is_error, true);
  assert.deepEqual(await edit(true), { type: "tool_result", tool_use_id: "test", content: "File edited" });
  assert.equal(await readFile(path.join(cwd, "a"), "utf8"), "y y y");
  const schema = tools().definitions.find(tool => tool.name === "Edit")?.input_schema;
  assert.ok(schema?.properties && "replace_all" in schema.properties);
  assert.deepEqual(schema.required?.slice().sort(), ["file_path", "new_string", "old_string"]);
  assert.equal((await run(tools(), "Edit", { file_path: "a", old_string: "y", new_string: "z", replace_all: "yes" })).is_error, true);
});

test("Edit errors leave content intact and no temp files", async t => {
  const { cwd, tools, run } = await fixture(t);
  await writeFile(path.join(cwd, "a"), "one two");
  await run(tools(), "Read", { file_path: "a" });
  for (const [old_string, new_string] of [["one", "one"], ["absent", "x"]]) {
    const result = await run(tools(), "Edit", { file_path: "a", old_string, new_string });
    assert.equal(result.is_error, true);
  }
  assert.match(String((await run(tools(), "Edit", { file_path: "a", old_string: "absent", new_string: "x" })).content), /^String to replace not found in file\.\nString: absent$/);
  assert.equal(await readFile(path.join(cwd, "a"), "utf8"), "one two");
  assert.deepEqual(await leftovers(cwd), []);
});

test("Edit keeps CRLF line endings and a BOM on disk", async t => {
  const { cwd, tools, run } = await fixture(t);
  await writeFile(path.join(cwd, "a"), "\uFEFFone\r\ntwo\r\nthree\r\n");
  await run(tools(), "Read", { file_path: "a" });
  const result = await run(tools(), "Edit", { file_path: "a", old_string: "one\ntwo", new_string: "1\n2" });
  assert.equal(result.is_error, undefined);
  assert.deepEqual(await readFile(path.join(cwd, "a")), Buffer.from("\uFEFF1\r\n2\r\nthree\r\n"));
});

test("Edit with empty new_string removes the trailing newline and treats $ literally", async t => {
  const { cwd, tools, run } = await fixture(t);
  await writeFile(path.join(cwd, "a"), "a\nb\nc\n");
  await run(tools(), "Read", { file_path: "a" });
  await run(tools(), "Edit", { file_path: "a", old_string: "b", new_string: "" });
  assert.equal(await readFile(path.join(cwd, "a"), "utf8"), "a\nc\n");
  await run(tools(), "Edit", { file_path: "a", old_string: "c", new_string: "$&-$1" });
  assert.equal(await readFile(path.join(cwd, "a"), "utf8"), "a\n$&-$1\n");
});

test("Write and Edit preserve file mode and leave no temp files", async t => {
  const { cwd, tools, run } = await fixture(t);
  const file = path.join(cwd, "a");
  await writeFile(file, "one"); await chmod(file, 0o640);
  await run(tools(), "Read", { file_path: "a" });
  assert.equal((await run(tools(), "Write", { file_path: "a", content: "two" })).content, "File written");
  assert.equal((await stat(file)).mode & 0o777, 0o640);
  assert.equal(await readFile(file, "utf8"), "two");
  assert.equal((await run(tools(), "Edit", { file_path: "a", old_string: "two", new_string: "three" })).content, "File edited");
  assert.equal((await stat(file)).mode & 0o777, 0o640);
  assert.equal(await readFile(file, "utf8"), "three");
  assert.deepEqual(await leftovers(cwd), []);
});

test("Write and Edit refuse symlink targets without touching the link target", async t => {
  const { cwd, tools, run } = await fixture(t);
  await writeFile(path.join(cwd, "real"), "real content");
  await symlink("real", path.join(cwd, "link"));
  assert.equal((await run(tools(), "Write", { file_path: "link", content: "bad" })).is_error, true);
  assert.equal((await run(tools(), "Edit", { file_path: "link", old_string: "real", new_string: "bad" })).is_error, true);
  assert.equal(await readFile(path.join(cwd, "real"), "utf8"), "real content");
  assert.equal((await lstat(path.join(cwd, "link"))).isSymbolicLink(), true);
  assert.deepEqual(await leftovers(cwd), []);
});

test("settings ask on Read/Glob/Grep precedes bypass and explicit allow without removing advertisement", async t => {
  const { combineToolPolicy, parseToolPolicy } = await import("../src/tool-policy.js");
  const { tools, run, approvals, cwd } = await fixture(t);
  await writeFile(path.join(cwd, "data.txt"), "needle");
  for (const mode of ["default", "acceptEdits", "plan", "bypassPermissions"] as const) {
    const policy = combineToolPolicy(parseToolPolicy({ allowedTools: ["Read,Glob,Grep"] }), ["Read", "Glob", "Grep"].map(rule => ({ source: "userSettings", behavior: "ask", rule })));
    const executor = tools(mode, false, policy);
    assert.equal(executor.definitions.some(tool => tool.name === "Read"), true);
    for (const [name, input] of [["Read", { file_path: "data.txt" }], ["Glob", { pattern: "**/*.txt" }], ["Grep", { pattern: "needle" }]] satisfies Array<[string, Record<string, unknown>]>) {
      const result = await run(executor, name, input);
      assert.equal(result.is_error, true);
      assert.equal(result.permissionDenied, true);
      assert.equal(result.inputRejected, undefined);
    }
  }
  assert.equal(approvals.length, 12);
  const approved = tools("bypassPermissions", true, { allowedTools: [], disallowedTools: [], askedTools: ["Read"] });
  assert.equal((await run(approved, "Read", { file_path: "data.txt" })).is_error, undefined);
  assert.equal(approvals.length, 13);
});

test("settings allow/deny/ask reaches mutation dispatch for every source and deny always wins", async t => {
  const { combineToolPolicy, parseToolPolicy } = await import("../src/tool-policy.js");
  const { tools, run, approvals, cwd } = await fixture(t);
  const sources = ["userSettings", "projectSettings", "localSettings", "flagSettings", "policySettings"] as const;
  for (const source of sources) {
    const allow = combineToolPolicy(parseToolPolicy({}), [{ source, behavior: "allow", rule: "Write" }]);
    assert.equal((await run(tools("default", false, allow), "Write", { file_path: `${source}.txt`, content: "allowed" })).is_error, undefined);
    for (const mode of ["default", "acceptEdits", "bypassPermissions"] as const) {
      const ask = combineToolPolicy(allow, [{ source, behavior: "ask", rule: "Write" }]);
      const askResult = await run(tools(mode, false, ask), "Write", { file_path: `${source}-${mode}.txt`, content: "not written" });
      assert.equal(askResult.permissionDenied, true);
      await assert.rejects(stat(path.join(cwd, `${source}-${mode}.txt`)), { code: "ENOENT" });
      const before = approvals.length;
      const deny = combineToolPolicy(ask, [{ source, behavior: "deny", rule: "Write" }]);
      const result = await run(tools(mode, true, deny), "Write", { file_path: `${source}-denied.txt`, content: "not written" });
      assert.equal(result.permissionDenied, true);
      assert.equal(approvals.length, before);
    }
  }
});

test("settings Read deny protects new Write and existing Edit, while CLI Read narrowing does not inherit", async t => {
  const { combineToolPolicy, parseToolPolicy } = await import("../src/tool-policy.js");
  const { tools, run, cwd, approvals } = await fixture(t);
  const cli = parseToolPolicy({ allowedTools: ["Write,Edit"], disallowedTools: ["Read"] });
  assert.equal((await run(tools("bypassPermissions", false, cli), "Write", { file_path: "cli.txt", content: "cli is only launch denial" })).is_error, undefined);
  const restricted = combineToolPolicy(cli, [{ source: "flagSettings", behavior: "deny", rule: "Read" }]);
  assert.equal(tools("bypassPermissions", true, restricted).definitions.some(tool => tool.name === "Read"), false);
  const write = await run(tools("bypassPermissions", true, restricted), "Write", { file_path: "new/nested.txt", content: "blocked" });
  const edit = await run(tools("bypassPermissions", true, restricted), "Edit", { file_path: "cli.txt", old_string: "cli", new_string: "bad" });
  assert.match(write.content, /Read deny rule/);
  assert.equal(write.permissionDenied, true);
  assert.equal(edit.permissionDenied, true);
  await assert.rejects(stat(path.join(cwd, "new")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(cwd, "cli.txt"), "utf8"), "cli is only launch denial");
  assert.deepEqual(approvals, []);
});

test("dispatch metadata distinguishes permission/input rejection from an ordinary missing-file Read", async t => {
  const { tools, run } = await fixture(t);
  const asked = tools("bypassPermissions", false, { allowedTools: [], disallowedTools: [], askedTools: ["Read"] });
  assert.equal((await run(asked, "Read", { file_path: "missing" })).permissionDenied, true);
  const malformed = await run(asked, "Read", {});
  assert.equal(malformed.inputRejected, true);
  assert.equal(malformed.permissionDenied, undefined);
  const missing = await run(tools(), "Read", { file_path: "missing" });
  assert.equal(missing.is_error, true);
  assert.equal(missing.permissionDenied, undefined);
  assert.equal(missing.inputRejected, undefined);
  const escape = await run(tools(), "Read", { file_path: "../outside" });
  assert.equal(escape.permissionDenied, true);
});

test("sensitive .claude writes/edits ask before whole allow or acceptEdits, while bypass waives the ordinary hold", async t => {
  const { tools, run, cwd, approvals } = await fixture(t);
  await mkdir(path.join(cwd, "nested/.claude"), { recursive: true });
  const file = "nested/.claude/CLAUDE.md";
  await writeFile(path.join(cwd, file), "instructions");
  const policy: ToolPolicy = { allowedTools: ["Read", "Write", "Edit"], disallowedTools: [] };
  // Original validation checks the read precondition before permission approval for an existing sensitive file.
  const unread = await run(tools("default", false, policy), "Write", { file_path: file, content: "no" });
  assert.match(unread.content, /Read the entire file/);
  assert.equal(approvals.length, 0);
  await run(tools("default", false, policy), "Read", { file_path: file });
  for (const mode of ["default", "acceptEdits"] as const) {
    const write = await run(tools(mode, false, policy), "Write", { file_path: file, content: "blocked" });
    const edit = await run(tools(mode, false, policy), "Edit", { file_path: file, old_string: "instructions", new_string: "blocked" });
    assert.equal(write.permissionDenied, true);
    assert.equal(edit.permissionDenied, true);
  }
  assert.equal(approvals.length, 4);
  assert.equal(await readFile(path.join(cwd, file), "utf8"), "instructions");
  assert.equal((await run(tools("bypassPermissions", false, policy), "Write", { file_path: file, content: "bypass" })).is_error, undefined);
  assert.equal(approvals.length, 4);
  assert.equal(await readFile(path.join(cwd, file), "utf8"), "bypass");
  assert.equal((await run(tools("bypassPermissions", false, { ...policy, askedTools: ["Write"] }), "Write", { file_path: file, content: "asked" })).permissionDenied, true);
  assert.equal(approvals.length, 5);
});

test("sensitive holds preserve plain CLAUDE and launch/worktree exceptions and can be accepted once", async t => {
  const { tools, run, cwd, approvals } = await fixture(t);
  const policy: ToolPolicy = { allowedTools: ["Write"], disallowedTools: [] };
  for (const file of ["CLAUDE.md", ".claude/launch.json", ".claude/worktrees/branch/source.ts"]) {
    assert.equal((await run(tools("default", false, policy), "Write", { file_path: file, content: "allowed" })).is_error, undefined);
  }
  assert.equal(approvals.length, 0);
  const held = await run(tools("default", false, policy), "Write", { file_path: ".mcp.json", content: "blocked" });
  assert.equal(held.permissionDenied, true);
  await assert.rejects(stat(path.join(cwd, ".mcp.json")), { code: "ENOENT" });
  assert.equal((await run(tools("default", true, policy), "Write", { file_path: ".mcp.json", content: "approved once" })).is_error, undefined);
  assert.equal(approvals.length, 2);
});
