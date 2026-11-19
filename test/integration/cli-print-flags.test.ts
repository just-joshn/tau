import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runCli } from "../helpers/cli-harness.js";
import { startMockProvider } from "../helpers/mock-provider.js";

setDefaultTimeout(30_000);

const said = (text: string) => ({
  kind: "turn" as const,
  content: [{ type: "text" as const, text }],
  stopReason: "end_turn" as const,
});

const result = z.looseObject({
  session_id: z.string(),
  result: z.string(),
  is_error: z.boolean(),
});

const sent = (request: { body: unknown } | undefined) =>
  JSON.stringify(request?.body);

const writeMarker = (file: string) => ({
  type: "command",
  command: process.execPath,
  args: [
    "-e",
    `require('node:fs').writeFileSync(${JSON.stringify(file)},'ran')`,
  ],
});

describe("settings", () => {
  test("problems are reported on stderr, naming the file when there is one", async () => {
    const provider = await startMockProvider([said("ok")]);
    const run = await runCli({
      provider,
      files: {
        "../config/settings.json": "{ not json",
        ".claude/settings.json": JSON.stringify({
          permissions: { allow: "Bash" },
        }),
      },
      args: ["-p", "hi"],
    });
    expect(run.exitCode).toBe(0);
    const userSettings = join(run.root, "config", "settings.json");
    expect(run.stderr).toMatch(
      new RegExp(
        `^Settings: .+ \\(${userSettings.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)$`,
        "m",
      ),
    );
    expect(run.stderr).toContain(
      "Settings: permissions.allow must be an array of strings\n",
    );
  });

  test("hooks given inline with --settings run", async () => {
    const provider = await startMockProvider([said("ok")]);
    const run = await runCli({
      provider,
      args: [
        "-p",
        "hi",
        "--settings",
        JSON.stringify({
          hooks: { Stop: [{ hooks: [writeMarker("inline-hook.txt")] }] },
        }),
      ],
    });
    expect(run.exitCode).toBe(0);
    expect(existsSync(join(run.cwd, "inline-hook.txt"))).toBe(true);
  });

  test("effortLevel is sent as the query effort for a first-party model", async () => {
    const provider = await startMockProvider([said("ok")]);
    const run = await runCli({
      provider,
      files: {
        ".claude/settings.json": JSON.stringify({ effortLevel: "low" }),
      },
      args: ["-p", "hi"],
    });
    expect(run.exitCode).toBe(0);
    expect(
      z
        .looseObject({ output_config: z.unknown() })
        .parse(provider.requests[0]?.body).output_config,
    ).toEqual({ effort: "low" });
  });

  test("a model without first-party effort support gets no effort parameter", async () => {
    const provider = await startMockProvider([said("ok")]);
    const run = await runCli({
      provider,
      files: {
        ".claude/settings.json": JSON.stringify({ effortLevel: "low" }),
      },
      args: ["-p", "hi", "--model", "acme-local-model"],
    });
    expect(run.exitCode).toBe(0);
    const body = z
      .looseObject({ model: z.string(), output_config: z.unknown().optional() })
      .parse(provider.requests[0]?.body);
    expect(body.model).toBe("acme-local-model");
    expect(body.output_config).toBeUndefined();
  });

  test("CLAUDE.md is sent unless claudeMdExcludes matches it; managed claudeMd is always sent", async () => {
    const provider = await startMockProvider([said("a"), said("b")]);
    const files = {
      "CLAUDE.md": "PROJECT_CODEWORD_PLUM",
      "../managed/managed-settings.json": JSON.stringify({
        claudeMd: "MANAGED_CODEWORD_KIWI",
      }),
    };
    const included = await runCli({ provider, files, args: ["-p", "hi"] });
    expect(included.exitCode).toBe(0);
    expect(sent(provider.requests[0])).toContain("PROJECT_CODEWORD_PLUM");
    expect(sent(provider.requests[0])).toContain("MANAGED_CODEWORD_KIWI");

    const excluded = await runCli({
      provider,
      files: {
        ...files,
        ".claude/settings.json": JSON.stringify({
          claudeMdExcludes: ["**/CLAUDE.md"],
        }),
      },
      args: ["-p", "hi"],
    });
    expect(excluded.exitCode).toBe(0);
    expect(sent(provider.requests[1])).not.toContain("PROJECT_CODEWORD_PLUM");
    expect(sent(provider.requests[1])).toContain("MANAGED_CODEWORD_KIWI");
  });

  test("plansDirectory places the session plan file under the workspace directory it names", async () => {
    const provider = await startMockProvider([said("planned")]);
    const run = await runCli({
      provider,
      files: {
        ".claude/settings.json": JSON.stringify({ plansDirectory: "designs" }),
      },
      args: ["-p", "plan it", "--permission-mode", "plan"],
    });
    expect(run.exitCode).toBe(0);
    const planFile = /Session plan file: ([^\s"\\]+)/.exec(
      sent(provider.requests[0]),
    )?.[1];
    expect(planFile).toStartWith(join(run.cwd, "designs") + "/");
  });
});

describe("sessions", () => {
  test("--continue resumes the latest session for the workspace", async () => {
    const provider = await startMockProvider([said("noted"), said("plums")]);
    const first = await runCli({
      provider,
      args: ["-p", "remember plums", "--output-format", "json"],
    });
    expect(first.exitCode).toBe(0);
    const second = await runCli({
      provider,
      env: { TAU_HOME: join(first.root, "state") },
      args: [
        "--cwd",
        first.cwd,
        "-c",
        "-p",
        "which fruit?",
        "--output-format",
        "json",
      ],
    });
    expect(second.exitCode).toBe(0);
    expect(result.parse(JSON.parse(second.stdout)).session_id).toBe(
      result.parse(JSON.parse(first.stdout)).session_id,
    );
    expect(sent(provider.requests[1])).toContain("remember plums");
  });
});

describe("results", () => {
  test("a reply with no content gives an empty, successful result", async () => {
    const provider = await startMockProvider([
      { kind: "turn", content: [], stopReason: "end_turn" },
    ]);
    const run = await runCli({
      provider,
      args: ["-p", "hi", "--output-format", "json"],
    });
    expect(run.exitCode).toBe(0);
    expect(result.parse(JSON.parse(run.stdout))).toMatchObject({
      result: "",
      is_error: false,
    });
  });

  test("a stream cut off after a complete block keeps the text and warns it is incomplete", async () => {
    const provider = await startMockProvider([
      {
        kind: "truncate",
        events: 3,
        content: [{ type: "text", text: "kept text" }],
      },
    ]);
    const run = await runCli({
      provider,
      args: ["-p", "hi", "--output-format", "json"],
    });
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain(
      "Response interrupted. The retained response may be incomplete.",
    );
    expect(result.parse(JSON.parse(run.stdout))).toMatchObject({
      result: "kept text",
      is_error: false,
    });
    expect(provider.requests.length).toBe(1);
  });
});

describe("paths outside the workspace", () => {
  const use = (name: string, input: Record<string, unknown>) => ({
    kind: "turn" as const,
    content: [{ type: "tool_use" as const, id: "outside", name, input }],
    stopReason: "tool_use" as const,
  });
  const outcome = (request: { body: unknown } | undefined) =>
    z
      .looseObject({
        messages: z.array(z.looseObject({ content: z.unknown() })),
      })
      .parse(request?.body)
      .messages.flatMap((message): unknown[] =>
        Array.isArray(message.content) ? message.content : [],
      )
      .flatMap((block) => {
        const parsed = z
          .looseObject({
            type: z.literal("tool_result"),
            tool_use_id: z.literal("outside"),
            is_error: z.boolean().optional(),
          })
          .safeParse(block);
        return parsed.success ? [parsed.data] : [];
      })
      .at(0);

  test("Read of a file outside the workspace is refused without its content", async () => {
    const provider = await startMockProvider([
      use("Read", { file_path: "../outside.txt" }),
      said("done"),
    ]);
    const run = await runCli({
      provider,
      files: { "../outside.txt": "OUTSIDE_SECRET" },
      args: ["-p", "read it", "--tools", "Read"],
    });
    expect(run.exitCode).toBe(0);
    expect(outcome(provider.requests[1])?.is_error).toBe(true);
    expect(sent(provider.requests[1])).not.toContain("OUTSIDE_SECRET");
  });

  test("Write to a file outside the workspace is refused and nothing is written", async () => {
    const provider = await startMockProvider([
      use("Write", { file_path: "../written.txt", content: "nope" }),
      said("done"),
    ]);
    const run = await runCli({
      provider,
      args: ["-p", "write it", "--tools", "Write"],
    });
    expect(run.exitCode).toBe(0);
    expect(outcome(provider.requests[1])?.is_error).toBe(true);
    expect(existsSync(join(run.root, "written.txt"))).toBe(false);
  });
});
