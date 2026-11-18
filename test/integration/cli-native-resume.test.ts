import { onTestFinished, test } from "bun:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { fixtureSse } from "../helpers/sse-fixture.js";

// Native accepts UUID shape without version/variant constraints; both import
// and subsequent Tau saves must retain that identity.
const ID = "11111111-1111-1111-1111-111111111111";
const bodySchema = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
});
const resultSchema = z.object({ session_id: z.string(), result: z.string() });

test(
  "native file resume preserves conversation and identity, uses current permissions/cwd, and saves an independently resumable Tau session",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "tau-native-import-")),
    );
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const cwd = join(root, "current"),
      config = join(root, "config"),
      state = join(root, "state");
    for (const directory of [
      cwd,
      config,
      state,
      join(root, "managed"),
      join(root, "home"),
    ])
      await mkdir(directory);
    await writeFile(join(cwd, "current.txt"), "CURRENT_WORKSPACE_BYTES");
    const nativePath = join(root, "exported.JSONL");
    const envelope = {
      sessionId: ID,
      isSidechain: false,
      cwd: "/foreign/original/project",
      version: "2.1.326",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    const nativeRows = [
      {
        type: "user",
        uuid: "u",
        parentUuid: null,
        ...envelope,
        message: { role: "user", content: "NATIVE_OLD_REQUEST" },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u",
        ...envelope,
        message: {
          role: "assistant",
          id: "native-response",
          model: "native-old-model",
          stop_reason: "tool_use",
          content: [
            {
              type: "thinking",
              thinking: "NATIVE_SIGNED_REASONING",
              signature: "NATIVE_SIGNATURE",
            },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "a2",
        parentUuid: "a1",
        ...envelope,
        message: {
          role: "assistant",
          id: "native-response",
          model: "native-old-model",
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "native-read",
              name: "Read",
              input: { file_path: "/foreign/original/project/old.txt" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "r",
        parentUuid: "a2",
        ...envelope,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "native-read",
              content: "NATIVE_OLD_FILE_RESULT",
            },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "a3",
        parentUuid: "r",
        ...envelope,
        message: {
          role: "assistant",
          id: "native-final",
          model: "native-old-model",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "NATIVE_OLD_FINAL" }],
        },
      },
      { type: "last-prompt", sessionId: ID, leafUuid: "a3" },
      { type: "unknown-passive-record", opaque: { retained: true } },
    ];
    const nativeText =
      nativeRows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    await writeFile(nativePath, nativeText);
    const bodies: z.infer<typeof bodySchema>[] = [];
    const api = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = bodySchema.parse(JSON.parse(raw));
      bodies.push(body);
      const content =
        bodies.length === 1
          ? [
              {
                type: "tool_use",
                id: "current-read",
                name: "Read",
                input: { file_path: "current.txt" },
              },
              {
                type: "tool_use",
                id: "current-write",
                name: "Write",
                input: { file_path: "blocked.txt", content: "MUST_NOT_WRITE" },
              },
            ]
          : [
              {
                type: "text",
                text:
                  bodies.length === 2
                    ? "NATIVE_IMPORT_FINISHED"
                    : "TAU_RESUME_FINISHED",
              },
            ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        fixtureSse([
          {
            type: "message_start",
            message: {
              id: `import-${bodies.length}`,
              role: "assistant",
              content: [],
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
          ...content.flatMap((block, index) => [
            { type: "content_block_start", index, content_block: block },
            { type: "content_block_stop", index },
          ]),
          {
            type: "message_delta",
            delta: {
              stop_reason: bodies.length === 1 ? "tool_use" : "end_turn",
            },
            usage: { output_tokens: 3 },
          },
          { type: "message_stop" },
        ]),
      );
    });
    await new Promise<void>((done) => api.listen(0, "127.0.0.1", done));
    onTestFinished(() => new Promise<void>((done) => api.close(() => done())));
    const address = api.address();
    assert.ok(address && typeof address === "object");
    const port = address.port;
    async function cli(resume: string, extraEnv: NodeJS.ProcessEnv = {}) {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("../../src/cli.ts", import.meta.url)),
          "--cwd",
          cwd,
          "-p",
          "CURRENT_PROMPT",
          "--resume",
          resume,
          "--model",
          "claude-sonnet-4-6",
          "--tools",
          "Read,Write",
          "--disallowedTools",
          "Write",
          "--output-format",
          "json",
        ],
        {
          env: {
            ...process.env,
            HOME: join(root, "home"),
            CLAUDE_CONFIG_DIR: config,
            TAU_MANAGED_ROOT: join(root, "managed"),
            TAU_HOME: state,
            ANTHROPIC_API_KEY: "dummy-owned",
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
            CLAUDE_CODE_POLL_EVENTS: "",
            CLAUDE_CODE_TETHER_LIVE: "",
            CLAUDE_CODE_STELLAR_DRIFT: "",
            CLAUDE_CODE_HUMBLE_HAMMOCK: "",
            CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "",
            ...extraEnv,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      onTestFinished(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      });
      child.stdin.end();
      let out = "",
        err = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      const code = await new Promise<number | null>((done, reject) => {
        child.on("error", reject);
        child.on("close", done);
      });
      return { code, out, err };
    }
    const imported = await cli(nativePath);
    assert.equal(imported.code, 0, JSON.stringify(imported));
    assert.deepEqual(resultSchema.parse(JSON.parse(imported.out)), {
      session_id: ID,
      result: "NATIVE_IMPORT_FINISHED",
    });
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0]?.model, "claude-sonnet-4-6");
    const history = JSON.stringify(bodies[0]?.messages);
    for (const marker of [
      "NATIVE_OLD_REQUEST",
      "NATIVE_OLD_FILE_RESULT",
      "NATIVE_OLD_FINAL",
      "CURRENT_PROMPT",
    ])
      assert.ok(history.includes(marker), marker);
    const second = JSON.stringify(bodies[1]?.messages);
    assert.match(second, /CURRENT_WORKSPACE_BYTES/);
    assert.match(second, /current-write/);
    await assert.rejects(readFile(join(cwd, "blocked.txt")), {
      code: "ENOENT",
    });
    assert.equal(await readFile(nativePath, "utf8"), nativeText);
    const resumed = await cli(ID);
    assert.equal(resumed.code, 0, resumed.err);
    assert.deepEqual(resultSchema.parse(JSON.parse(resumed.out)), {
      session_id: ID,
      result: "TAU_RESUME_FINISHED",
    });
    assert.match(JSON.stringify(bodies[2]?.messages), /NATIVE_IMPORT_FINISHED/);
    assert.equal(await readFile(nativePath, "utf8"), nativeText);
    // Compaction/context rows cannot be silently dropped by the ordinary importer.
    const unsupported = join(root, "compacted.jsonl");
    await writeFile(
      unsupported,
      nativeText +
        JSON.stringify({
          type: "system",
          uuid: "compact",
          parentUuid: "a3",
          ...envelope,
          subtype: "compact_boundary",
        }) +
        "\n",
    );
    const rejected = await cli(unsupported);
    assert.notEqual(rejected.code, 0);
    assert.match(
      rejected.err,
      /full fold adapter|unsupported-retraction-or-compaction/,
    );
    assert.equal(bodies.length, 3);

    const contextualPath = join(root, "recorded-context.jsonl");
    const contextualRows = [
      {
        type: "user",
        uuid: "cu",
        parentUuid: null,
        ...envelope,
        message: { role: "user", content: "CONTEXTUAL_NATIVE_PROMPT" },
      },
      {
        type: "attachment",
        uuid: "ce",
        parentUuid: "cu",
        ...envelope,
        attachment: { type: "environment", snapshot: {} },
        rendered: [
          {
            content:
              "<system-reminder>\nRECORDED_ENVIRONMENT\n</system-reminder>",
          },
        ],
        renderedRole: "system",
      },
      {
        type: "assistant",
        uuid: "ca",
        parentUuid: "ce",
        ...envelope,
        message: {
          role: "assistant",
          id: "contextual-native-final",
          model: "claude-sonnet-4-6",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "CONTEXTUAL_NATIVE_FINAL" }],
        },
      },
      {
        type: "attachment",
        uuid: "cs",
        parentUuid: "ca",
        ...envelope,
        attachment: {
          type: "prompt_snapshot",
          systemPrompt: ["NATIVE_SYSTEM_MUST_NOT_REPLACE_CURRENT"],
          tools: [],
          reminderFold: false,
        },
      },
      { type: "last-prompt", sessionId: ID, leafUuid: "cs" },
    ];
    const contextualText =
      contextualRows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    await writeFile(contextualPath, contextualText);
    const contextual = await cli(contextualPath);
    assert.equal(contextual.code, 0, JSON.stringify(contextual));
    assert.equal(bodies.length, 4);
    const contextualHistory = JSON.stringify(bodies[3]?.messages);
    assert.ok(
      contextualHistory.indexOf("RECORDED_ENVIRONMENT") <
        contextualHistory.indexOf("CONTEXTUAL_NATIVE_PROMPT"),
    );
    assert.match(contextualHistory, /CONTEXTUAL_NATIVE_FINAL/);
    assert.equal(
      contextualHistory.includes("NATIVE_SYSTEM_MUST_NOT_REPLACE_CURRENT"),
      false,
    );
    assert.equal(await readFile(contextualPath, "utf8"), contextualText);

    const toolPath = join(root, "tool-context.jsonl"),
      reminder = "<system-reminder>\nOWNED_TOOL_CONTEXT\n</system-reminder>";
    const toolRows = [
      nativeRows[0],
      {
        type: "attachment",
        uuid: "tool-initial-snapshot",
        parentUuid: "u",
        ...envelope,
        attachment: {
          type: "prompt_snapshot",
          systemPrompt: [],
          tools: [],
          echoWireToolInputs: true,
          contextRendering: "inline",
          reminderFold: false,
        },
      },
      { ...nativeRows[1], parentUuid: "tool-initial-snapshot" },
      nativeRows[2],
      nativeRows[3],
      {
        type: "attachment",
        uuid: "tool-context",
        parentUuid: "r",
        ...envelope,
        attachment: { type: "date", date: "owned" },
        rendered: [{ content: reminder }],
        renderedRole: "system",
      },
      {
        type: "assistant",
        uuid: "tool-tail",
        parentUuid: "tool-context",
        ...envelope,
        message: {
          role: "assistant",
          id: "native-response",
          model: "native-old-model",
          stop_reason: "tool_use",
          content: [{ type: "text", text: "NATIVE_LATE_RESPONSE_FRAGMENT" }],
        },
      },
      { ...nativeRows[4], parentUuid: "tool-tail" },
      {
        type: "attachment",
        uuid: "tool-final-snapshot",
        parentUuid: "a3",
        ...envelope,
        attachment: {
          type: "prompt_snapshot",
          systemPrompt: [],
          tools: [],
          echoWireToolInputs: false,
          contextRendering: "announced",
          reminderFold: false,
        },
      },
      { type: "last-prompt", sessionId: ID, leafUuid: "tool-final-snapshot" },
    ];
    const toolText =
      toolRows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    await writeFile(toolPath, toolText);
    const toolImported = await cli(toolPath);
    assert.equal(toolImported.code, 0, JSON.stringify(toolImported));
    assert.equal(bodies.length, 5);
    const wire = z
      .array(z.object({ role: z.string(), content: z.array(z.unknown()) }))
      .parse(bodies[4]?.messages);
    const assistant = wire.find(
      (message) =>
        message.role === "assistant" &&
        JSON.stringify(message.content).includes("native-read"),
    );
    assert.ok(assistant);
    assert.match(JSON.stringify(assistant.content), /NATIVE_SIGNED_REASONING/);
    assert.match(JSON.stringify(assistant.content), /NATIVE_SIGNATURE/);
    assert.match(
      JSON.stringify(assistant.content),
      /NATIVE_LATE_RESPONSE_FRAGMENT/,
    );
    const nativeResult = z.object({
      type: z.literal("tool_result"),
      tool_use_id: z.literal("native-read"),
      content: z.string(),
    });
    const matching = wire
      .flatMap((message) => message.content)
      .map((block) => nativeResult.safeParse(block))
      .find((parsed) => parsed.success);
    assert.ok(matching?.success);
    assert.equal(
      matching.data.content,
      "NATIVE_OLD_FILE_RESULT\n\n" + reminder,
    );
    assert.equal(
      wire
        .flatMap((message) => message.content)
        .some(
          (block) =>
            z
              .object({ type: z.literal("text"), text: z.literal(reminder) })
              .safeParse(block).success,
        ),
      false,
    );
    assert.equal(await readFile(toolPath, "utf8"), toolText);
    for (const env of [
      { CLAUDE_CODE_POLL_EVENTS: "true" },
      { CLAUDE_CODE_TETHER_LIVE: "1" },
      { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "true" },
      { CLAUDE_CODE_HUMBLE_HAMMOCK: "true" },
      { CLAUDE_CODE_STELLAR_DRIFT: "true" },
    ]) {
      const rejected = await cli(toolPath, env);
      assert.notEqual(rejected.code, 0);
      assert.match(
        rejected.err,
        /poll\/tether\/Code Mode capability host|unsupported-native-wire-input-echo|API block-index wire adapter/,
      );
      assert.equal(bodies.length, 5);
      assert.equal(await readFile(toolPath, "utf8"), toolText);
    }
    const folded = join(root, "last-snapshot-fold.jsonl");
    await writeFile(
      folded,
      toolText.replace(
        '"echoWireToolInputs":false,"contextRendering":"announced","reminderFold":false',
        '"echoWireToolInputs":false,"contextRendering":"announced","reminderFold":true',
      ),
    );
    const unsupportedTail = await cli(folded);
    assert.notEqual(unsupportedTail.code, 0);
    assert.match(
      unsupportedTail.err,
      /unsupported-tool-context-projection-gates/,
    );
    assert.equal(bodies.length, 5);
  },
  { timeout: 15000 },
);
