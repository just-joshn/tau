import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished, test } from "bun:test";
import { z } from "zod";
import { fixtureSse } from "../helpers/sse-fixture.js";

const row = z.object({
  type: z.unknown().optional(),
  message: z
    .object({
      content: z.array(z.looseObject({ text: z.string().optional() })),
    })
    .optional(),
  result: z.unknown().optional(),
});

test(
  "print outputs select the final text block while stream-json assistant messages retain earlier text",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "tau-print-result-")),
    );
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    for (const name of ["config", "managed", "home"])
      await mkdir(join(root, name));
    await writeFile(join(root, "a.txt"), "owned");
    let calls = 0;
    const api = createServer(async (request, response) => {
      for await (const _chunk of request) {
        /* consume owned mock request */
      }
      const first = ++calls % 2 === 1;
      const blocks = first
        ? [
            { type: "text", text: "before tool" },
            {
              type: "tool_use",
              id: `read-${calls}`,
              name: "Read",
              input: { file_path: "a.txt" },
            },
          ]
        : [
            { type: "text", text: "earlier text block" },
            { type: "text", text: "final answer" },
          ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        fixtureSse([
          {
            type: "message_start",
            message: {
              id: `unique-${calls}`,
              role: "assistant",
              content: [],
              usage: { input_tokens: 5, output_tokens: 0 },
            },
          },
          ...blocks.flatMap((block, index) => [
            { type: "content_block_start", index, content_block: block },
            { type: "content_block_stop", index },
          ]),
          {
            type: "message_delta",
            delta: { stop_reason: first ? "tool_use" : "end_turn" },
            usage: { output_tokens: 2 },
          },
          { type: "message_stop" },
        ]),
      );
    });
    onTestFinished(
      () =>
        new Promise<void>((done) => {
          api.closeAllConnections();
          api.close(() => done());
        }),
    );
    await new Promise<void>((done) => api.listen(0, "127.0.0.1", done));
    const address = api.address();
    assert.ok(address && typeof address !== "string");
    for (const format of ["text", "json", "stream-json"]) {
      const result = await new Promise<{
        code: number | null;
        out: string;
        err: string;
      }>((done, reject) => {
        const child = spawn(
          process.execPath,
          [
            fileURLToPath(new URL("../../src/cli.ts", import.meta.url)),
            "-p",
            "read owned",
            "--cwd",
            root,
            "--output-format",
            format,
            ...(format === "stream-json" ? ["--verbose"] : []),
          ],
          {
            env: {
              ...process.env,
              HOME: join(root, "home"),
              CLAUDE_CONFIG_DIR: join(root, "config"),
              TAU_MANAGED_ROOT: join(root, "managed"),
              TAU_HOME: join(root, "state"),
              ANTHROPIC_API_KEY: "owned-dummy",
              ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let out = "",
          err = "";
        child.stdout.on("data", (chunk) => (out += chunk));
        child.stderr.on("data", (chunk) => (err += chunk));
        child.on("error", reject);
        child.on("close", (code) => done({ code, out, err }));
      });
      assert.equal(result.code, 0, result.err);
      if (format === "text") assert.equal(result.out, "final answer\n");
      else {
        const rows = result.out
          .trim()
          .split("\n")
          .map((line) => row.parse(JSON.parse(line)));
        assert.equal(rows.at(-1)?.result, "final answer");
        if (format === "stream-json")
          assert.deepEqual(
            rows
              .filter((r) => r.type === "assistant")
              .flatMap((r) => r.message?.content.map((block) => block.text)),
            ["before tool", undefined, "earlier text block", "final answer"],
          );
      }
    }
    assert.equal(calls, 6);
  },
  { timeout: 15000 },
);
