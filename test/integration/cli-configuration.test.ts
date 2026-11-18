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
import { join, resolve } from "node:path";
import { onTestFinished, test } from "bun:test";
import { z } from "zod";
import { fixtureSse } from "../helpers/sse-fixture.js";

function cli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [resolve("src/cli.ts"), ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.setEncoding("utf8").on("data", (value) => {
      out += value;
    });
    child.stderr.setEncoding("utf8").on("data", (value) => {
      err += value;
    });
    child.on("error", reject);
    child.on("close", (code) => done({ code, out, err }));
  });
}

const bodySchema = z.looseObject({
  model: z.string(),
  system: z.string(),
  messages: z.array(z.looseObject({ content: z.unknown() })),
});
type Body = z.infer<typeof bodySchema>;
const firstBlocksSchema = z.array(
  z.object({ is_error: z.boolean().optional() }),
);
const printSchema = z.object({ session_id: z.string(), is_error: z.boolean() });
const lastFirstIsError = (body: Body | undefined) =>
  firstBlocksSchema.parse(body?.messages.at(-1)?.content)[0]?.is_error;

test(
  "compiled layered settings/instructions coding→resume reloads files/permissions while retaining model/system snapshots",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "tau-cli-configuration-")),
    );
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const cwd = join(root, "work"),
      user = join(root, "user"),
      managed = join(root, "managed");
    for (const path of [
      join(cwd, ".claude"),
      join(cwd, "nested"),
      user,
      managed,
    ])
      await mkdir(path, { recursive: true });
    await writeFile(join(cwd, "nested/a.txt"), "alpha\n");
    const fixtures = async (version: string, restricted: boolean) => {
      await writeFile(
        join(user, "settings.json"),
        JSON.stringify({
          model: "claude-haiku-4-5",
          permissions: { deny: restricted ? ["Write"] : [] },
        }),
      );
      await writeFile(
        join(cwd, ".claude/settings.json"),
        JSON.stringify({
          model: "claude-sonnet-4-6",
          permissions: { allow: ["Write"], deny: restricted ? ["Edit"] : [] },
        }),
      );
      await writeFile(
        join(cwd, ".claude/settings.local.json"),
        JSON.stringify({
          model: restricted ? "claude-opus-4-6" : "claude-sonnet-4-6",
          permissions: { allow: ["Edit", "Write"] },
        }),
      );
      await writeFile(join(user, "CLAUDE.md"), `USER_${version}\n`);
      await writeFile(join(cwd, "CLAUDE.md"), `ROOT_${version}\n`);
      await writeFile(join(cwd, "CLAUDE.local.md"), `LOCAL_${version}\n`);
      await writeFile(join(cwd, "nested/CLAUDE.md"), `NESTED_${version}\n`);
    };
    await fixtures("V1", true);
    let phase = "first",
      index = 0;
    const bodies: Body[] = [];
    const steps = () =>
      phase === "first"
        ? [
            ["Read", { file_path: "nested/a.txt" }],
            [
              "Edit",
              {
                file_path: "nested/CLAUDE.md",
                old_string: "NESTED",
                new_string: "CHANGED",
              },
            ],
            ["Write", { file_path: "output.txt", content: "must not exist" }],
          ]
        : phase === "resume"
          ? [
              [
                "Edit",
                {
                  file_path: "CLAUDE.md",
                  old_string: "ROOT",
                  new_string: "CHANGED",
                },
              ],
              ["Read", { file_path: "nested/a.txt" }],
              [
                "Edit",
                {
                  file_path: "nested/CLAUDE.md",
                  old_string: "NESTED",
                  new_string: "CHANGED",
                },
              ],
              ["Write", { file_path: "nested/a.txt", content: "final\n" }],
            ]
          : [];
    const api = createServer(async (incoming, response) => {
      let raw = "";
      for await (const chunk of incoming) raw += chunk;
      const body = bodySchema.parse(JSON.parse(raw));
      bodies.push(body);
      const step = steps()[index++];
      const block = step
        ? {
            type: "tool_use",
            id: `${phase}-${index}`,
            name: step[0],
            input: step[1],
          }
        : { type: "text", text: "Done." };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        fixtureSse([
          {
            type: "message_start",
            message: {
              role: "assistant",
              model: body.model,
              content: [],
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
          { type: "content_block_start", index: 0, content_block: block },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: step ? "tool_use" : "end_turn" },
            usage: { output_tokens: 3 },
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
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: user,
      TAU_MANAGED_ROOT: managed,
      TAU_HOME: join(root, "state"),
      ANTHROPIC_MODEL: undefined,
      ANTHROPIC_API_KEY: "dummy",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    };
    const args = [
      "-p",
      "FIRST",
      "--cwd",
      cwd,
      "--output-format",
      "json",
      "--append-system-prompt",
      "SYSTEM_V1",
    ];
    const first = await cli(args, env);
    assert.equal(first.code, 0, first.err);
    const result = printSchema.parse(JSON.parse(first.out));
    assert.equal(result.is_error, false);
    assert.equal(bodies.length, 4);
    assert.equal(bodies[0]?.model, "claude-opus-4-6");
    const initial = JSON.stringify(bodies[0]?.messages);
    for (const marker of ["USER_V1", "ROOT_V1", "LOCAL_V1"])
      assert.ok(initial.includes(marker));
    assert.equal(initial.includes("NESTED_V1"), false);
    assert.equal(JSON.stringify(bodies[0]?.system).includes("ROOT_V1"), false);
    assert.ok(
      JSON.stringify(bodies[1]?.messages.at(-1)?.content).includes("NESTED_V1"),
    );
    assert.equal(lastFirstIsError(bodies[2]), true);
    assert.equal(lastFirstIsError(bodies[3]), true);
    await assert.rejects(readFile(join(cwd, "output.txt")), { code: "ENOENT" });
    await fixtures("V2", false);
    phase = "resume";
    index = 0;
    const before = bodies.length;
    const resumed = await cli(
      [
        "-p",
        "RESUME",
        "--cwd",
        cwd,
        "--output-format",
        "json",
        "--resume",
        result.session_id,
        "--append-system-prompt",
        "SYSTEM_V2",
      ],
      env,
    );
    assert.equal(resumed.code, 0, resumed.err);
    assert.equal(bodies.length - before, 5);
    const resumedInitial = bodies[before];
    assert.equal(resumedInitial?.model, "claude-opus-4-6");
    assert.ok(resumedInitial?.system.includes("SYSTEM_V1"));
    assert.equal(resumedInitial?.system.includes("SYSTEM_V2"), false);
    assert.ok(
      JSON.stringify(resumedInitial?.messages.at(-1)).includes("ROOT_V2"),
    );
    assert.equal(lastFirstIsError(bodies[before + 1]), true); // eager files do not seed print Read state
    assert.equal(lastFirstIsError(bodies[before + 3]), undefined); // nested full text does seed
    assert.equal(
      await readFile(join(cwd, "nested/CLAUDE.md"), "utf8"),
      "CHANGED_V2\n",
    );
    assert.equal(await readFile(join(cwd, "nested/a.txt"), "utf8"), "final\n");
    phase = "off";
    index = 0;
    const off = await cli(
      [
        "-p",
        "OFF",
        "--cwd",
        cwd,
        "--output-format",
        "json",
        "--resume",
        result.session_id,
        "--system-prompt-snapshot",
        "off",
        "--append-system-prompt",
        "SYSTEM_V3",
      ],
      env,
    );
    assert.equal(off.code, 0, off.err);
    assert.ok(bodies.at(-1)?.system.includes("SYSTEM_V3"));
    assert.equal(bodies.at(-1)?.system.includes("SYSTEM_V1"), false);
    assert.equal(JSON.stringify(bodies).includes('"instructionFiles"'), false);
    assert.equal(JSON.stringify(bodies).includes('"permissionDenied"'), false);
  },
  { timeout: 15000 },
);
