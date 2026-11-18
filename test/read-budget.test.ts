import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createTools } from "../src/tools.js";
import { ReadState } from "../src/read-state.js";
import { checkFileTokens, FILE_READ_BYTES, fileReadTokenLimit, selectTextFile, tokenPage } from "../src/file-read.js";
import { fixtureSse } from "./sse-fixture.js";

async function fixture(t: TestContext, options: Partial<Parameters<typeof createTools>[0]> = {}) {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "tau-read-budget-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const state = new ReadState(), file = path.join(cwd, "a");
  const tools = createTools({ cwd, readState: state, mode: "bypassPermissions", approve: async () => true, ...options });
  const run = (name: string, input: Record<string, unknown>, signal = t.signal) => tools.execute({ type: "tool_use", name, input, id: "tool" }, signal);
  const read = (input: Record<string, unknown> = {}, signal = t.signal) => run("Read", { file_path: "a", ...input }, signal);
  return { cwd, file, tools, state, run, read };
}

test("file Read token setting uses the recovered positive integer grammar", () => {
  assert.equal(fileReadTokenLimit({}), 25000);
  for (const value of ["0", "-1", "invalid"]) assert.equal(fileReadTokenLimit({ CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: value }), 25000);
  for (const value of ["1_000", "1e3", "1000tokens"]) assert.equal(fileReadTokenLimit({ CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: value }), 1000);
});

test("counting starts above one quarter and failures fall back to the estimate", async t => {
  let calls = 0;
  const count = async () => { calls++; return 5; };
  assert.equal(await checkFileTokens("x".repeat(8), "a", 10, true, t.signal, count), 2); assert.equal(calls, 0);
  assert.equal(await checkFileTokens("x".repeat(12), "a", 10, true, t.signal, count), 5); assert.equal(calls, 1);
  assert.equal(await checkFileTokens("x".repeat(5), "a.json", 10, true, t.signal, count), 5); assert.equal(calls, 2);
  await assert.rejects(checkFileTokens("x".repeat(48), "a", 10, true, t.signal, async () => { throw new Error("offline"); }), /12.*10/);
});

test("whole text can exceed old input/output caps without being truncated", async t => {
  const f = await fixture(t); const text = "x".repeat(80000); await writeFile(f.file, text);
  assert.equal((await f.read()).content, "1\t" + text);
  f.state.assertCurrent(f.file, Buffer.from(text));
});

test("whole-file token overflow selects a line page with an actionable next offset", async t => {
  const f = await fixture(t, { fileReadMaxTokens: 50 }); const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  await writeFile(f.file, lines.join("\n"));
  const result = await f.read(); assert.equal(result.is_error, undefined);
  assert.match(result.content, /^\[Read truncated by token limit: lines 1-\d+ of 100\./);
  const match = /offset=(\d+) limit=(\d+)/.exec(result.content)!; assert.ok(match); assert.equal(+match[1]!, +match[2]! + 1);
  assert.throws(() => f.state.assertCurrent(f.file, Buffer.from(lines.join("\n"))), /Read the entire/);
  const page = await f.read({ offset: +match[1]!, limit: 1 }); assert.equal(page.content, `${match[1]}\tline ${+match[1]! - 1}`);
});

test("long-line and whitespace pages use a character prefix without broken surrogates", async t => {
  const f = await fixture(t, { fileReadMaxTokens: 5 }); await writeFile(f.file, "🌍".repeat(100));
  const result = await f.read({ offset: 0 }); assert.equal(result.is_error, undefined);
  assert.match(result.content, /first \d+ of 200 characters/); assert.match(result.content, /\n1\t/);
  const shown = result.content.split("\t")[1]!; assert.equal(Buffer.from(shown).toString(), shown); assert.doesNotMatch(shown, /\ufffd/);
  const white = tokenPage("\n".repeat(100), 25, 5); assert.equal(white.byCharacters, true); assert.ok(white.text.length < 100);
});

test("explicit limit or later offset errors on token overflow instead of paging", async t => {
  const f = await fixture(t, { fileReadMaxTokens: 10 }); await writeFile(f.file, "head\n" + "x".repeat(100));
  for (const input of [{ offset: 2 }, { offset: 2, limit: 1 }, { limit: 2 }]) {
    const result = await f.read(input); assert.equal(result.is_error, true); assert.match(result.content, /tokens.*smaller line range/);
    assert.doesNotMatch(result.content, /Read truncated/);
  }
});

test("a selected-byte overflow fails before counting, while a whole read can count the same text", async t => {
  let counts = 0; const f = await fixture(t, { fileReadMaxTokens: 10, readTokenCounter: async () => { counts++; return 1; } });
  await writeFile(f.file, "x".repeat(1500));
  assert.equal((await f.read({ limit: 1 })).is_error, true); assert.equal(counts, 0);
  assert.equal((await f.read()).content, "1\t" + "x".repeat(1500)); assert.equal(counts, 1);
});

test("a large regular file can be scanned for a later explicit range without loading its prefix", async t => {
  const f = await fixture(t); await writeFile(f.file, "skip".repeat(3 * 1024 * 1024) + "\nselected\nlast");
  const result = await f.read({ offset: 2, limit: 1 }); assert.equal(result.content, "2\tselected");
  const whole = await f.read(); assert.equal(whole.is_error, true); assert.match(whole.content, /262144/);
});

test("UTF8 and UTF16 decoders handle characters split across actual read chunks", async t => {
  const f = await fixture(t);
  await writeFile(f.file, Buffer.from("x".repeat(524282) + "\nhi😀\nend"));
  assert.equal((await f.read({ offset: 2, limit: 1 })).content, "2\thi😀");
  await writeFile(f.file, Buffer.from("\ufeff" + "x".repeat(262141) + "\n😀\nend", "utf16le"));
  assert.equal((await f.read({ offset: 2, limit: 1 })).content, "2\t😀");
});

test("streamed ranges preserve CRLF and EOF line counts across a chunk boundary", async t => {
  const f = await fixture(t); await writeFile(f.file, "x".repeat(524287) + "\r\nα\r\n");
  assert.equal((await f.read({ offset: 2, limit: 2 })).content, "2\tα\n3\t");
  const handle = await open(f.file, "r");
  try { const result = await selectTextFile(handle, { offset: 4, limit: 1 }, t.signal, 25000); assert.equal(result.totalLines, 3); assert.equal(result.lineCount, 0); }
  finally { await handle.close(); }
});

test("malformed text outside the selected range still fails the complete scan", async t => {
  const f = await fixture(t); await writeFile(f.file, Buffer.concat([Buffer.from("ok\n" + "x".repeat(600000)), Buffer.from([0xff])]));
  assert.equal((await f.read({ limit: 1 })).is_error, true);
});

test("a failed range does not erase the preceding valid Read cache entry", async t => {
  const f = await fixture(t, { fileReadMaxTokens: 10 }); await writeFile(f.file, "old"); await f.read();
  await writeFile(f.file, "new".repeat(100)); assert.equal((await f.read({ limit: 1 })).is_error, true);
  f.state.assertCurrent(f.file, Buffer.from("old"));
  assert.equal((await f.run("Edit", { file_path: "a", old_string: "new", new_string: "changed" })).is_error, true);
});

test("partial token pages cannot collectively grant a full-file edit baseline", async t => {
  const f = await fixture(t, { fileReadMaxTokens: 10 }); const text = "line\n".repeat(20); await writeFile(f.file, text);
  await f.read(); for (let offset = 1; offset <= 21; offset++) await f.read({ offset, limit: 1 });
  assert.equal((await f.run("Write", { file_path: "a", content: "lost" })).is_error, true);
});

test("aborting auxiliary counting never commits a new Read baseline", async t => {
  const controller = new AbortController(); const f = await fixture(t, { fileReadMaxTokens: 10, readTokenCounter: async () => { controller.abort(); return 1; } });
  await writeFile(f.file, "x".repeat(100)); const result = await f.read({}, controller.signal);
  assert.equal(result.is_error, true); assert.throws(() => f.state.assertCurrent(f.file, Buffer.from("x".repeat(100))), /Read the entire/);
});

test("repeated local regular-text Reads return the actual contents rather than a guessed unchanged notice", async t => {
  const f = await fixture(t); await writeFile(f.file, "same");
  assert.equal((await f.read()).content, "1\tsame"); assert.equal((await f.read()).content, "1\tsame");
});

test("compiled CLI counts whole and later range Reads separately from three generation attempts", { timeout: 15000 }, async t => {
  const f = await fixture(t), text = Array.from({ length: 400 }, (_, i) => `line${i} ` + "x".repeat(294)).join("\n");
  await writeFile(f.file, text); const requests: Array<{ url: string; body: any }> = []; let generation = 0, counts = 0, nextOffset = 0;
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); requests.push({ url: req.url!, body });
    if (req.url!.includes("count_tokens")) {
      counts++; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ input_tokens: counts === 1 ? 28000 : 8000 })); return;
    }
    generation++;
    if (generation === 2) {
      const content = body.messages.at(-1).content[0].content as string; assert.ok(Buffer.byteLength(content) > 65536);
      const match = /offset=(\d+) limit=/.exec(content)!; assert.ok(match); nextOffset = +match[1]!;
    }
    if (generation === 3) { const content = body.messages.at(-1).content[0].content as string; assert.match(content, new RegExp(`^${nextOffset}\\tline${nextOffset - 1} `)); assert.ok(content.includes("line399 ")); }
    const block = generation === 1 ? { type: "tool_use", id: "whole", name: "Read", input: { file_path: "a" } } : generation === 2 ?
      { type: "tool_use", id: "later", name: "Read", input: { file_path: "a", offset: nextOffset, limit: 400 } } : { type: "text", text: "Done" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(fixtureSse([{ type: "message_start", message: { role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: block }, { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: generation < 3 ? "tool_use" : "end_turn" }, usage: { output_tokens: 2 } }, { type: "message_stop" }]));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const addr = server.address(); assert.ok(addr && typeof addr !== "string");
  const pending = promisify(execFile)(process.execPath, [path.resolve("dist/src/cli.js"), "--cwd", f.cwd, "--print", "read file", "--model", "claude-sonnet-4-5", "--max-api-attempts", "3", "--max-retries", "0", "--output-format", "json"],
    { env: { ...process.env, ANTHROPIC_API_KEY: "loopback", ANTHROPIC_BASE_URL: `http://127.0.0.1:${addr.port}`, TAU_HOME: path.join(f.cwd, "state") }, maxBuffer: 1024 * 1024, signal: t.signal });
  pending.child.stdin?.end();
  const result = await pending;
  assert.equal(JSON.parse(result.stdout).result, "Done"); assert.equal(generation, 3); assert.equal(counts, 2); assert.equal(requests.length, 5);
  assert.equal(FILE_READ_BYTES, 262144); assert.equal(await readFile(f.file, "utf8"), text);
});

test("short OS reads can split the encoding marker and a UTF16 surrogate", async t => {
  const f = await fixture(t); await writeFile(f.file, Buffer.from("\ufeffα😀\r\nβ", "utf16le"));
  const handle = await open(f.file, "r");
  try {
    const fragmented = { stat: handle.stat.bind(handle), read: (buffer: Buffer, offset: number, length: number, position: number) => handle.read(buffer, offset, Math.min(1, length), position) } as unknown as typeof handle;
    const result = await selectTextFile(fragmented, { offset: 1 }, t.signal, 25000);
    assert.equal(result.text, "α😀\nβ"); assert.equal(result.totalLines, 2);
  } finally { await handle.close(); }
});
