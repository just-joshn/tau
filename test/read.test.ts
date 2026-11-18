import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, onTestFinished } from "bun:test";
import { createTools } from "../src/tools.js";

async function workspace() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "tau-read-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const tools = createTools({
    cwd,
    mode: "plan",
    approve: async () => assert.fail("Read must not request approval"),
  });
  const run = (
    input: Record<string, unknown>,
    signal = new AbortController().signal,
  ) =>
    tools.execute(
      { type: "tool_use", id: "read", name: "Read", input },
      signal,
    );
  return { cwd, tools, run };
}

const MAX_BYTES = 65536;

test("Read advertises file_path, offset, limit and allow_large with strict bounds", async () => {
  const { tools } = await workspace();
  const definition = tools.definitions.find((tool) => tool.name === "Read");
  assert.ok(definition);
  assert.match(definition.description, /offset/i);
  assert.match(definition.description, /limit/i);
  const schema = definition.input_schema;
  assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [
    "allow_large",
    "file_path",
    "limit",
    "offset",
  ]);
  assert.deepEqual(schema.required, ["file_path"]);
  assert.equal(schema.additionalProperties, false);
  const filePath = schema.properties?.file_path;
  assert.ok(filePath && typeof filePath === "object");
  assert.ok("minLength" in filePath && "maxLength" in filePath);
  assert.equal(filePath.minLength, 1);
  assert.equal(filePath.maxLength, 4096);
  const offset = schema.properties?.offset;
  assert.ok(offset && typeof offset === "object");
  assert.ok("default" in offset);
  assert.equal(offset.default, 1);
  const limit = schema.properties?.limit;
  assert.ok(limit && typeof limit === "object");
  assert.equal("default" in limit, false);
  for (const [name, required] of [
    ["Glob", ["pattern"]],
    ["Grep", ["pattern"]],
    ["Bash", ["command"]],
  ] satisfies Array<[string, string[]]>) {
    assert.deepEqual(
      tools.definitions.find((tool) => tool.name === name)?.input_schema
        .required,
      required,
    );
  }
});

test("Read numbers lines and applies offset before an optional limit, including offset zero", async () => {
  const { cwd, run } = await workspace();
  await writeFile(path.join(cwd, "lines"), "alpha\nbeta\ngamma");
  for (const [input, expected] of [
    [{ file_path: "lines" }, "1\talpha\n2\tbeta\n3\tgamma"],
    [{ file_path: "lines", offset: 1 }, "1\talpha\n2\tbeta\n3\tgamma"],
    [{ file_path: "lines", offset: 0 }, "0\talpha\n1\tbeta\n2\tgamma"],
    [{ file_path: "lines", offset: 0, limit: 1 }, "0\talpha"],
    [{ file_path: "lines", offset: 2 }, "2\tbeta\n3\tgamma"],
    [{ file_path: "lines", offset: 2, limit: 1 }, "2\tbeta"],
    [{ file_path: "lines", offset: 3, limit: 10 }, "3\tgamma"],
  ] satisfies Array<[Record<string, unknown>, string]>) {
    const result = await run(input);
    assert.equal(result.is_error, undefined);
    assert.equal(result.content, expected);
  }
});

test("Read distinguishes empty files, numbered blank lines and trailing LF", async () => {
  const { cwd, run } = await workspace();
  for (const [text, expected] of [
    ["", "[empty file]"],
    ["\n", "1\t\n2\t"],
    ["first\n\nlast\n", "1\tfirst\n2\t\n3\tlast\n4\t"],
    ["first\r\nsecond\r\n", "1\tfirst\n2\tsecond\n3\t"],
    ["left\rright\nlast\r", "1\tleft\rright\n2\tlast"],
  ] satisfies Array<[string, string]>) {
    await writeFile(path.join(cwd, "text"), text);
    const result = await run({ file_path: "text" });
    assert.equal(result.is_error, undefined);
    assert.equal(result.content, expected);
  }
});

test("Read beyond a complete file reports EOF as a successful result", async () => {
  const { cwd, run } = await workspace();
  await writeFile(path.join(cwd, "lines"), "first\n");
  assert.equal((await run({ file_path: "lines", offset: 2 })).content, "2\t");
  for (const offset of [3, 100]) {
    const result = await run({ file_path: "lines", offset });
    assert.equal(result.is_error, undefined);
    assert.match(result.content, /end of file|offset|line count/i);
    assert.doesNotMatch(result.content, /^\d+\t/m);
  }
});

test("Read has neither a default 2000-line limit nor a 2000-character line limit", async () => {
  const { cwd, run } = await workspace();
  const lines = Array.from({ length: 2105 }, (_, index) => `line-${index + 1}`);
  await writeFile(path.join(cwd, "many"), lines.join("\n"));
  assert.equal(
    (await run({ file_path: "many" })).content,
    lines.map((line, index) => `${index + 1}\t${line}`).join("\n"),
  );
  const long = "x".repeat(5000);
  await writeFile(path.join(cwd, "long"), long);
  assert.equal((await run({ file_path: "long" })).content, `1\t${long}`);
});

test("Read rejects coercion, invalid bounds, aliases and unsupported keys", async () => {
  const { cwd, run } = await workspace();
  await writeFile(path.join(cwd, "text"), "valid");
  const invalid: Array<Record<string, unknown>> = [
    {},
    { file_path: "" },
    { file_path: 1 },
    { file_path: null },
    { file_path: "x\0x" },
    { file_path: "x".repeat(4097) },
    { file_path: "😀".repeat(2049) },
    { path: "text" },
    { filePath: "text" },
  ];
  for (const offset of [
    -1,
    0.5,
    "1",
    null,
    true,
    NaN,
    Infinity,
    [1],
    Number.MAX_SAFE_INTEGER + 1,
  ])
    invalid.push({ file_path: "text", offset });
  for (const limit of [
    0,
    -1,
    0.5,
    "1",
    null,
    true,
    NaN,
    Infinity,
    [1],
    Number.MAX_SAFE_INTEGER + 1,
  ])
    invalid.push({ file_path: "text", limit });
  for (const extra of [
    { pages: "1" },
    { allow_large: "true" },
    { allow_large: 1 },
    { allow_large: null },
    { _host: {} },
    { length: 1 },
    { description: "read" },
    { path: "text" },
    { filePath: "text" },
    { start_line: 1 },
    { end_line: 2 },
    { unknown: true },
  ])
    invalid.push({ file_path: "text", ...extra });
  for (const input of invalid) {
    assert.equal((await run(input)).is_error, true, JSON.stringify(input));
  }
});

test("Read accepts UTF-8, strips only its leading BOM and preserves Unicode content", async () => {
  const { cwd, run } = await workspace();
  await writeFile(path.join(cwd, "unicode"), "\ufeffcafé 😀\ninside\ufefftext");
  const result = await run({ file_path: "unicode" });
  assert.equal(result.is_error, undefined);
  assert.equal(result.content, "1\tcafé 😀\n2\tinside\ufefftext");
  await writeFile(path.join(cwd, "bom-only"), Buffer.from([0xef, 0xbb, 0xbf]));
  assert.equal((await run({ file_path: "bom-only" })).content, "[empty file]");
  await writeFile(path.join(cwd, "unicode-output"), "€".repeat(21845));
  const uncut = await run({ file_path: "unicode-output" });
  assert.equal(uncut.is_error, undefined);
  assert.equal(uncut.content, `1\t${"€".repeat(21845)}`);
  assert.ok(Buffer.byteLength(uncut.content) > MAX_BYTES);
});

test("Read rejects NUL, invalid UTF-8, UTF-16BE and recognized media instead of displaying bytes", async () => {
  const { cwd, run } = await workspace();
  const invalid = [
    Buffer.from("text\0tail"),
    Buffer.from([0xff]),
    Buffer.from([0x80]),
    Buffer.from([0xc0, 0xaf]),
    Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from([0xe2, 0x82]),
    Buffer.from([0xfe, 0xff, 0x00, 0x41]),
    Buffer.from("%PDF-1.7\nfixture"),
    Buffer.from("GIF87afixture"),
    Buffer.from("GIF89afixture"),
    Buffer.from("RIFF1234WEBPfixture"),
    Buffer.concat([
      Buffer.from("ok\n"),
      Buffer.alloc(MAX_BYTES - 4, 0x61),
      Buffer.from([0]),
    ]),
  ];
  for (const [index, bytes] of invalid.entries()) {
    await writeFile(path.join(cwd, "invalid"), bytes);
    const result = await run({ file_path: "invalid", limit: 1 });
    assert.equal(
      result.is_error,
      true,
      `invalid encoding/media fixture ${index}`,
    );
  }
});

test("Read uses the 256KiB whole-file limit and explicit ranges avoid it", async () => {
  const { cwd, run } = await workspace();
  const prefix = "ok\n" + "x".repeat(262144 - 3);
  await writeFile(path.join(cwd, "exact"), prefix);
  assert.equal((await run({ file_path: "exact", limit: 1 })).content, "1\tok");
  assert.match(
    (await run({ file_path: "exact" })).content,
    /truncated by token limit/,
  );
  await writeFile(path.join(cwd, "large"), prefix + "unseen-tail");
  assert.equal((await run({ file_path: "large", limit: 1 })).content, "1\tok");
  const all = await run({ file_path: "large" });
  assert.equal(all.is_error, true);
  assert.match(all.content, /262144.*offset.*limit/i);
});

test("Read scans beyond the old prefix and reports real EOF for later ranges", async () => {
  const { cwd, run } = await workspace();
  await writeFile(
    path.join(cwd, "large"),
    "x\n".repeat(MAX_BYTES / 2) + "unseen",
  );
  assert.equal(
    (await run({ file_path: "large", offset: MAX_BYTES / 2, limit: 2 }))
      .content,
    "32768\tx\n32769\tunseen",
  );
  assert.equal(
    (await run({ file_path: "large", offset: 32769 })).content,
    "32769\tunseen",
  );
  const beyond = await run({ file_path: "large", offset: 40000 });
  assert.equal(beyond.is_error, undefined);
  assert.match(beyond.content, /end of file/);
});

test("Read decodes a UTF8 sequence crossing the former prefix boundary", async () => {
  const { cwd, run } = await workspace();
  const prefix = Buffer.concat([
    Buffer.from("x".repeat(MAX_BYTES - 7) + "\nsmall"),
    Buffer.from([0xe2]),
  ]);
  await writeFile(
    path.join(cwd, "unicode-tail"),
    Buffer.concat([prefix, Buffer.from([0x82, 0xac])]),
  );
  const result = await run({ file_path: "unicode-tail", offset: 2, limit: 1 });
  assert.equal(result.is_error, undefined);
  assert.equal(result.content, "2\tsmall€");
});

test("Read rejects missing and nonregular files, excluded trees and pre-aborted calls", async () => {
  const { cwd, run } = await workspace();
  await mkdir(path.join(cwd, "directory"));
  for (const file_path of ["absent", "directory"]) {
    assert.equal((await run({ file_path })).is_error, true);
  }
  for (const excluded of ["node_modules", ".tau"]) {
    await mkdir(path.join(cwd, excluded));
    await writeFile(path.join(cwd, excluded, "hidden"), "hidden");
    assert.equal(
      (await run({ file_path: `${excluded}/hidden` })).is_error,
      true,
    );
  }
  await writeFile(path.join(cwd, "text"), "ok");
  const controller = new AbortController();
  controller.abort();
  const aborted = await run({ file_path: "text" }, controller.signal);
  assert.equal(aborted.is_error, true);
  assert.match(aborted.content, /abort/i);
});
