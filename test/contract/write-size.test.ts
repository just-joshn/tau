import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished, test } from "bun:test";
import { z } from "zod";
import { createTools } from "../../src/tools.js";
import { ReadState } from "../../src/read-state.js";
import { ModelContextRoom } from "../../src/context-room.js";
import {
  MAX_EDIT_BYTES,
  MAX_UNSIZED_FILE_BYTES,
  readFileSnapshot,
} from "../../src/file-snapshot.js";
import { writeAtomic } from "../../src/write.js";
import { fixtureSse } from "../helpers/sse-fixture.js";

const requestSchema = z.object({
  messages: z.array(
    z.object({
      content: z.array(z.object({ is_error: z.boolean().optional() })),
    }),
  ),
});
const resultSchema = z.object({ result: z.string() });

async function fixture() {
  const cwd = await realpath(
    await mkdtemp(path.join(tmpdir(), "tau-write-size-")),
  );
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const controller = new AbortController();
  onTestFinished(() => controller.abort());
  const state = new ReadState(),
    tools = createTools({
      cwd,
      readState: state,
      mode: "bypassPermissions",
      approve: async () => true,
    });
  tools.setReadContext?.({
    room: new ModelContextRoom(
      () => 1000000,
      1013000,
      () => 0,
    ),
    bytesPerToken: 4,
    countTokens: async () => 200000,
  });
  const run = (
    name: string,
    input: Record<string, unknown>,
    signal = controller.signal,
  ) => tools.execute({ type: "tool_use", name, input, id: "tool" }, signal);
  const file = path.join(cwd, "a"),
    read = () => run("Read", { file_path: "a", allow_large: true });
  return { cwd, file, state, tools, run, read, signal: controller.signal };
}

test("a complete300KB Read permits Edit and Write beyond the old64KiB mutation bound", async () => {
  const f = await fixture(),
    text = "head\n" + "x".repeat(300000) + "\ntail";
  await writeFile(f.file, text);
  await chmod(f.file, 0o640);
  assert.equal((await f.read()).is_error, undefined);
  assert.equal(
    (
      await f.run("Edit", {
        file_path: "a",
        old_string: "tail",
        new_string: "TAIL",
      })
    ).content,
    "File edited",
  );
  assert.equal(await readFile(f.file, "utf8"), text.slice(0, -4) + "TAIL");
  assert.equal(
    (await f.run("Write", { file_path: "a", content: "replacement" })).content,
    "File written",
  );
  assert.equal(await readFile(f.file, "utf8"), "replacement");
  assert.equal((await stat(f.file)).mode & 0o777, 0o640);
  assert.deepEqual(await readdir(f.cwd), ["a"]);
});

test("Write accepts content above1MiB and consecutive Edit uses its full known-content baseline", async () => {
  const f = await fixture(),
    content = "head\n" + "x".repeat(1100000) + "\ntail";
  assert.equal(
    (await f.run("Write", { file_path: "a", content })).content,
    "File written",
  );
  assert.equal(
    (
      await f.run("Edit", {
        file_path: "a",
        old_string: "tail",
        new_string: "end",
      })
    ).content,
    "File edited",
  );
  assert.equal(await readFile(f.file, "utf8"), content.slice(0, -4) + "end");
  assert.equal(
    (await f.run("Write", { file_path: "a", content: "final" })).content,
    "File written",
  );
});

test("Write's10MiB diff threshold does not become an input or existing-file limit", async () => {
  const f = await fixture(),
    content = "x".repeat(10485761);
  assert.equal(
    (await f.run("Write", { file_path: "a", content })).content,
    "File written",
  );
  assert.equal((await stat(f.file)).size, content.length);
  assert.equal(
    (await f.run("Write", { file_path: "a", content: "small" })).content,
    "File written",
  );
  assert.equal(await readFile(f.file, "utf8"), "small");
});

test("large UTF16LE/BOM/CRLF Edit retains encoding, newlines and permissions", async () => {
  const f = await fixture(),
    text = "\ufeffhead\r\n" + "α".repeat(140000) + "\r\ntail\r\n";
  await writeFile(f.file, Buffer.from(text, "utf16le"));
  await chmod(f.file, 0o600);
  assert.equal((await f.read()).is_error, undefined);
  assert.equal(
    (
      await f.run("Edit", {
        file_path: "a",
        old_string: "tail\n",
        new_string: "TAIL\nnext\n",
      })
    ).content,
    "File edited",
  );
  const bytes = await readFile(f.file);
  assert.deepEqual([...bytes.subarray(0, 2)], [255, 254]);
  assert.equal(
    bytes.toString("utf16le"),
    text.replace("tail\r\n", "TAIL\r\nnext\r\n"),
  );
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
});

test("large UTF8 BOM Write preserves its BOM and may truncate to empty", async () => {
  const f = await fixture();
  await writeFile(f.file, "\ufeff" + "x".repeat(300000));
  await f.read();
  assert.equal(
    (await f.run("Write", { file_path: "a", content: "β".repeat(150000) }))
      .content,
    "File written",
  );
  assert.equal(await readFile(f.file, "utf8"), "\ufeff" + "β".repeat(150000));
  assert.equal(
    (await f.run("Write", { file_path: "a", content: "" })).content,
    "File written",
  );
  assert.equal((await stat(f.file)).size, 0);
});

test("changes beyond the former prefix are rejected even if mtime is restored", async () => {
  const f = await fixture(),
    text = "head\n" + "x".repeat(300000) + "\ntail";
  await writeFile(f.file, text);
  await f.read();
  const before = await stat(f.file),
    changed = text.slice(0, -4) + "else";
  await writeFile(f.file, changed);
  await utimes(f.file, before.atime, before.mtime);
  for (const [name, input] of [
    ["Edit", { file_path: "a", old_string: "head", new_string: "HEAD" }],
    ["Write", { file_path: "a", content: "lost" }],
  ] as const) {
    const result = await f.run(name, input);
    assert.equal(result.is_error, true);
    assert.match(result.content, /changed.*Read|Read.*again/i);
  }
  assert.equal(await readFile(f.file, "utf8"), changed);
});

test("a partial large-file Read never authorizes replacement", async () => {
  const f = await fixture();
  await writeFile(f.file, "head\n" + "x".repeat(300000));
  await f.run("Read", { file_path: "a", limit: 1 });
  assert.equal(
    (await f.run("Write", { file_path: "a", content: "lost" })).is_error,
    true,
  );
  assert.equal((await stat(f.file)).size, 300005);
});

test("Edit checks the exact1GiB metadata boundary before loading an unread sparse file", async () => {
  const f = await fixture();
  await writeFile(f.file, "");
  await truncate(f.file, MAX_EDIT_BYTES);
  const at = await f.run("Edit", {
    file_path: "a",
    old_string: "x",
    new_string: "y",
  });
  assert.equal(at.is_error, true);
  assert.match(at.content, /Read the entire file/);
  await truncate(f.file, MAX_EDIT_BYTES + 1);
  const over = await f.run("Edit", {
    file_path: "a",
    old_string: "x",
    new_string: "y",
  });
  assert.equal(over.is_error, true);
  assert.match(over.content, /1073741824-byte Edit limit/);
});

test("unread Write does not inherit Edit's size cutoff or load a giant file", async () => {
  const f = await fixture();
  await writeFile(f.file, "");
  await truncate(f.file, MAX_EDIT_BYTES + 1);
  const result = await f.run("Write", { file_path: "a", content: "lost" });
  assert.equal(result.is_error, true);
  assert.match(result.content, /Read the entire file/);
  assert.equal((await stat(f.file)).size, MAX_EDIT_BYTES + 1);
});

test("precommit snapshot checking catches a same-size large tail change and removes the temp file", async () => {
  const f = await fixture(),
    original = Buffer.from("x".repeat(300000) + "tail"),
    changed = Buffer.from("x".repeat(300000) + "else");
  await writeFile(f.file, original);
  await assert.rejects(
    writeAtomic(f.file, "proposal", async () => {
      await writeFile(f.file, changed);
      await readFileSnapshot(f.file, f.signal, { expected: original });
    }),
    /changed before write/,
  );
  assert.deepEqual(await readFile(f.file), changed);
  assert.deepEqual(await readdir(f.cwd), ["a"]);
});

test("expected creation snapshot refuses a file created before commit", async () => {
  const f = await fixture();
  await writeFile(f.file, "external");
  await assert.rejects(
    readFileSnapshot(f.file, f.signal, { expected: null }),
    /changed before write/,
  );
  assert.equal(
    await readFileSnapshot(path.join(f.cwd, "absent"), f.signal, {
      expected: null,
    }),
    null,
  );
});

test("snapshot reading refuses symlinks and cancellation without changing files", async () => {
  const f = await fixture();
  await writeFile(f.file, "x".repeat(300000));
  await symlink("a", path.join(f.cwd, "link"));
  await assert.rejects(readFileSnapshot(path.join(f.cwd, "link"), f.signal));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readFileSnapshot(f.file, controller.signal), {
    name: "AbortError",
  });
  assert.equal((await stat(f.file)).size, 300000);
});

test("atomic write verifies UTF8 byte length and returns the verified integer mtime", async () => {
  const f = await fixture(),
    content = "β".repeat(150000);
  await writeFile(f.file, "old");
  await chmod(f.file, 0o640);
  const timestamp = await writeAtomic(f.file, content);
  assert.equal(timestamp, Math.floor((await stat(f.file)).mtimeMs));
  assert.equal((await stat(f.file)).size, 300000);
  assert.equal(await readFile(f.file, "utf8"), content);
  assert.equal((await stat(f.file)).mode & 0o777, 0o640);
  assert.deepEqual(await readdir(f.cwd), ["a"]);
});

test("post-rename truncation reports verification failure after the committed file changed", async () => {
  const f = await fixture();
  await writeFile(f.file, "old");
  await assert.rejects(
    writeAtomic(f.file, Buffer.alloc(300000, 120), undefined, {
      rename: async (source, target) => {
        await rename(source, target);
        await truncate(target, 100000);
      },
    }),
    /Write verification failed.*100000.*300000/,
  );
  assert.equal((await stat(f.file)).size, 100000);
  assert.deepEqual(await readdir(f.cwd), ["a"]);
});

test(
  "compiled CLI streams Write input above1MiB then Edit and overwrite share the verified baseline",
  async () => {
    const f = await fixture(),
      content = "head\n" + "x".repeat(1100000) + "\ntail";
    let generation = 0;
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = requestSchema.parse(JSON.parse(raw));
      generation++;
      assert.equal(req.url, "/v1/messages?beta=true");
      if (generation > 1)
        assert.equal(body.messages.at(-1)?.content[0]?.is_error, undefined);
      const block =
        generation === 1
          ? {
              type: "tool_use",
              id: "write-large",
              name: "Write",
              input: { file_path: "a", content },
            }
          : generation === 2
            ? {
                type: "tool_use",
                id: "edit-large",
                name: "Edit",
                input: {
                  file_path: "a",
                  old_string: "tail",
                  new_string: "TAIL",
                },
              }
            : generation === 3
              ? {
                  type: "tool_use",
                  id: "write-small",
                  name: "Write",
                  input: { file_path: "a", content: "final\n" },
                }
              : { type: "text", text: "Done" };
      if (generation === 2)
        assert.equal(await readFile(f.file, "utf8"), content);
      if (generation === 3)
        assert.equal(
          await readFile(f.file, "utf8"),
          content.slice(0, -4) + "TAIL",
        );
      const events: unknown[] = [
        {
          type: "message_start",
          message: {
            role: "assistant",
            content: [],
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        },
      ];
      if (block.type === "tool_use") {
        events.push({
          type: "content_block_start",
          index: 0,
          content_block: { ...block, input: {} },
        });
        const input = JSON.stringify(block.input);
        for (let i = 0; i < input.length; i += 65536)
          events.push({
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: input.slice(i, i + 65536),
            },
          });
      } else
        events.push({
          type: "content_block_start",
          index: 0,
          content_block: block,
        });
      events.push(
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: generation < 4 ? "tool_use" : "end_turn" },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      );
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(fixtureSse(events));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    onTestFinished(async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    });
    const addr = server.address();
    assert.ok(addr && typeof addr !== "string");
    const pending = promisify(execFile)(
      process.execPath,
      [
        path.resolve("src/cli.ts"),
        "--cwd",
        f.cwd,
        "--print",
        "write and edit",
        "--permission-mode",
        "acceptEdits",
        "--model",
        "claude-sonnet-4-5",
        "--output-format",
        "json",
        "--max-api-attempts",
        "4",
        "--max-retries",
        "0",
      ],
      {
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: "loopback",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${addr.port}`,
          TAU_HOME: path.join(f.cwd, "state"),
        },
        maxBuffer: 1024 * 1024,
        signal: f.signal,
      },
    );
    pending.child.stdin?.end();
    const result = await pending;
    assert.equal(resultSchema.parse(JSON.parse(result.stdout)).result, "Done");
    assert.equal(generation, 4);
    assert.equal(await readFile(f.file, "utf8"), "final\n");
  },
  { timeout: 15000 },
);

test("a zero-size snapshot has the separate10MiB guard if the regular file grows after stat", async () => {
  const f = await fixture();
  await writeFile(f.file, "");
  const accepted = await readFileSnapshot(f.file, f.signal, {
    requireRead: () =>
      writeFileSync(f.file, Buffer.alloc(MAX_UNSIZED_FILE_BYTES, 120)),
  });
  assert.ok(accepted);
  assert.equal(accepted.length, MAX_UNSIZED_FILE_BYTES);
  await writeFile(f.file, "");
  await assert.rejects(
    readFileSnapshot(f.file, f.signal, {
      requireRead: () =>
        writeFileSync(f.file, Buffer.alloc(MAX_UNSIZED_FILE_BYTES + 1, 120)),
    }),
    /reporting zero size exceeds 10485760/,
  );
  assert.equal((await stat(f.file)).size, MAX_UNSIZED_FILE_BYTES + 1);
});
