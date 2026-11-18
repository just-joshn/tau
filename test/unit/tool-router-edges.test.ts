import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "bun:test";
import { parseOptions } from "../../src/options.js";
import {
  routeExternalTools,
  type ExternalToolRegistry,
} from "../../src/tool-router.js";
import type {
  PreToolHookResult,
  ToolFailureHookResult,
  ToolHookRuntime,
} from "../../src/tool-hook-runtime.js";
import { ToolPermissionDenied } from "../../src/tool-policy.js";
import { UNPARSED_TOOL_INPUT } from "../../src/tool-input.js";
import type { PermissionMode, ToolResult } from "../../src/types.js";
import { failureFeedback, hookTexts } from "../helpers/hook-attachments.js";

const name = "mcp__fixture__lookup";

interface FixtureOptions {
  mode?: PermissionMode;
  flags?: string[];
  readOnly?: boolean;
  approve?: (description: string) => Promise<boolean>;
  validateInput?: (name: string, input: unknown) => unknown;
  callTool?: () => Promise<{
    raw: unknown;
    projection: { text: string; isError?: boolean };
  }>;
  hooks?: ToolHookRuntime;
  hookOutputDirectory?: string;
  definitions?: string[];
}

function fixture(options: FixtureOptions = {}) {
  const inputs: unknown[] = [];
  const prompts: string[] = [];
  const mode = options.mode ?? "bypassPermissions";
  const registry: ExternalToolRegistry = {
    definitions: (options.definitions ?? [name]).map((tool) => ({
      name: tool,
      description: "fixture",
      input_schema: { type: "object" },
    })),
    lookup: (tool) =>
      tool === name
        ? {
            serverName: "fixture",
            isReadOnly: options.readOnly ?? false,
            requiresUserInteraction: false,
          }
        : undefined,
    ...(options.validateInput ? { validateInput: options.validateInput } : {}),
    async callTool(_tool, input) {
      inputs.push(input);
      return options.callTool
        ? options.callTool()
        : {
            raw: { content: [{ type: "text", text: "ok" }] },
            projection: { text: "ok" },
          };
    },
  };
  const approve =
    options.approve ??
    (async (description: string) => {
      prompts.push(description);
      return true;
    });
  const tools = routeExternalTools(
    {
      definitions: [],
      execute: async () => assert.fail("built-ins must not run"),
    },
    registry,
    {
      mode,
      policy: parseOptions(options.flags ?? []).toolPolicy,
      approve,
      ...(options.hooks ? { hooks: options.hooks } : {}),
      ...(options.hookOutputDirectory
        ? { hookOutputDirectory: options.hookOutputDirectory }
        : {}),
    },
  );
  const run = (input: unknown, signal = new AbortController().signal) =>
    tools.execute({ type: "tool_use", id: "call", name, input }, signal);
  return { tools, run, inputs, prompts };
}

function hooks(
  pre: Partial<PreToolHookResult>,
  extra: Partial<ToolHookRuntime> = {},
): ToolHookRuntime {
  return {
    async before() {
      return { additionalContext: [], preventContinuation: false, ...pre };
    },
    async after(_call, result) {
      return result;
    },
    ...extra,
  };
}

test("an external definition without server metadata stays advertised", () => {
  const { tools } = fixture({
    definitions: [name, "mcp__unknown__tool"],
    flags: ["--disallowed-tools", "mcp__fixture"],
  });
  assert.deepEqual(
    tools.definitions.map((tool) => tool.name),
    ["mcp__unknown__tool"],
  );
});

test("malformed or non-object MCP arguments are rejected before the server is called", async () => {
  const { run, inputs } = fixture();
  const malformed = await run({
    [UNPARSED_TOOL_INPUT]: { raw: "{oops", len: 5 },
  });
  assert.equal(malformed.is_error, true);
  assert.equal(malformed.inputRejected, true);
  assert.match(malformed.content, /failed to parse.*5 bytes/);
  for (const input of [null, "text", ["a"]]) {
    const result = await run(input);
    assert.equal(result.inputRejected, true);
    assert.equal(result.content, "MCP tool arguments must be an object");
  }
  assert.deepEqual(inputs, []);
});

test("host validation failures keep permission denials and wrap other errors as input rejections", async () => {
  const thrown: unknown[] = [
    new ToolPermissionDenied("host says no"),
    new Error("missing field q"),
    "not an error",
  ];
  const results: ToolResult[] = [];
  for (const error of thrown) {
    const { run, inputs } = fixture({
      validateInput: () => {
        throw error;
      },
    });
    results.push(await run({ q: 1 }));
    assert.deepEqual(inputs, []);
  }
  assert.deepEqual(
    results.map((result) => [
      result.content,
      result.permissionDenied,
      result.inputRejected,
    ]),
    [
      ["host says no", true, undefined],
      ["missing field q", undefined, true],
      ["MCP input validation failed", undefined, true],
    ],
  );
});

test("host validation output is what the server receives", async () => {
  const { run, inputs } = fixture({
    validateInput: (_tool, input) => ({ normalized: input }),
  });
  assert.equal((await run({ q: 1 })).content, "ok");
  assert.deepEqual(inputs, [{ normalized: { q: 1 } }]);
});

test("a pre-hook that stops continuation returns its stop reason without calling the server", async () => {
  const stopped = fixture({
    hooks: hooks({ preventContinuation: true, stopReason: "halt now" }),
  });
  const result = await stopped.run({});
  assert.equal(result.content, "halt now");
  assert.equal(result.is_error, true);
  assert.deepEqual(result.hookStop, { reason: "halt now" });
  const silent = fixture({ hooks: hooks({ preventContinuation: true }) });
  const fallback = await silent.run({});
  assert.equal(fallback.content, "Tool call stopped by hook");
  assert.deepEqual(fallback.hookStop, {
    reason: "Continuation stopped by hook",
  });
  assert.deepEqual([...stopped.inputs, ...silent.inputs], []);
});

test("pre-hook deny and defer decisions become permission denials", async () => {
  const cases: Array<[Partial<PreToolHookResult>, string]> = [
    [{ permission: "deny" }, "Tool denied by hook"],
    [
      { permission: "deny", reason: "blocked by policy hook" },
      "blocked by policy hook",
    ],
    [
      { permission: "defer" },
      "Hook requested deferred approval; this runner cannot resume deferred tool calls",
    ],
  ];
  for (const [pre, content] of cases) {
    const { run, inputs } = fixture({ hooks: hooks(pre) });
    const result = await run({});
    assert.equal(result.content, content);
    assert.equal(result.permissionDenied, true);
    assert.deepEqual(inputs, []);
  }
});

test("a pre-hook replacement input is revalidated, sent to the server and reported", async () => {
  const { run, inputs } = fixture({
    hooks: hooks({ updatedInput: { q: "rewritten" } }),
  });
  const result = await run({ q: "original" });
  assert.deepEqual(inputs, [{ q: "rewritten" }]);
  assert.deepEqual(result.effectiveToolInput, { q: "rewritten" });

  const invalid = fixture({
    hooks: hooks({ updatedInput: ["not", "object"] }),
  });
  const rejected = await invalid.run({ q: "original" });
  assert.equal(rejected.inputRejected, true);
  assert.deepEqual(rejected.effectiveToolInput, { q: "original" });
  assert.deepEqual(invalid.inputs, []);
});

test("a pre-hook allow preapproves plan mode only for read-only tools", async () => {
  const readOnly = fixture({
    mode: "plan",
    readOnly: true,
    hooks: hooks({ permission: "allow" }),
  });
  assert.equal((await readOnly.run({})).content, "ok");
  assert.deepEqual(readOnly.prompts, []);
  const mutating = fixture({
    mode: "plan",
    hooks: hooks({ permission: "allow" }),
  });
  assert.equal((await mutating.run({ q: 1 })).content, "ok");
  assert.deepEqual(mutating.prompts, [
    'MCP tool mcp__fixture__lookup\n{"q":1}',
  ]);
  const ordinary = fixture({
    mode: "default",
    hooks: hooks({ permission: "allow" }),
  });
  assert.equal((await ordinary.run({})).content, "ok");
  assert.deepEqual(ordinary.prompts, []);
});

test("approval failures and aborts during approval deny the call", async () => {
  const failures: unknown[] = [new Error("prompt closed"), "gone"];
  const contents: string[] = [];
  for (const failure of failures) {
    const { run, inputs } = fixture({
      mode: "default",
      approve: async () => {
        throw failure;
      },
    });
    const result = await run({});
    assert.equal(result.permissionDenied, true);
    assert.deepEqual(inputs, []);
    contents.push(result.content);
  }
  assert.deepEqual(contents, [
    "prompt closed",
    "Permission approval did not complete",
  ]);

  const controller = new AbortController();
  const aborted = fixture({
    mode: "default",
    approve: async () => {
      controller.abort();
      return true;
    },
  });
  const result = await aborted.run({}, controller.signal);
  assert.equal(result.content, "Permission approval aborted");
  assert.equal(result.permissionDenied, true);
  assert.deepEqual(aborted.inputs, []);
});

test("a server failure runs the failure hook and appends its context", async () => {
  const seen: unknown[] = [];
  const failure = async (
    _call: unknown,
    error: unknown,
  ): Promise<ToolFailureHookResult> => {
    seen.push(error);
    return failureFeedback("failure noted");
  };
  const { run } = fixture({
    callTool: async () => {
      throw "server exploded";
    },
    hooks: hooks({}, { failure }),
  });
  const result = await run({});
  assert.equal(result.content, "MCP tool failed");
  assert.equal(result.is_error, true);
  assert.equal(result.permissionDenied, undefined);
  assert.deepEqual(hookTexts(result.hookAttachments), ["failure noted"]);
  assert.deepEqual(seen, ["server exploded"]);
});

test("a throwing failure hook still yields the server error", async () => {
  const { run } = fixture({
    callTool: async () => {
      throw new Error("server down");
    },
    hooks: hooks(
      {},
      {
        failure: async () => {
          throw new Error("hook broke");
        },
      },
    ),
  });
  const result = await run({});
  assert.equal(result.content, "server down");
  assert.equal(result.is_error, true);
  assert.equal(result.hookAttachments, undefined);
});

test("a post-hook replacement output is projected, keeping its error flag and saving binaries to the hook directory", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tau-router-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const replaced: ToolResult[] = [];
  const { run } = fixture({
    hookOutputDirectory: directory,
    hooks: hooks(
      {},
      {
        async after(_call, result, _signal, validateOutput) {
          assert.ok(validateOutput);
          replaced.push(
            await validateOutput(
              {
                content: [
                  {
                    type: "audio",
                    data: Buffer.from("wav").toString("base64"),
                    mimeType: "audio/wav",
                  },
                ],
              },
              result,
            ),
            await validateOutput(
              {
                content: [{ type: "text", text: "hook error" }],
                isError: true,
              },
              result,
            ),
          );
          return result;
        },
      },
    ),
  });
  assert.equal((await run({})).content, "ok");
  const [saved, failed] = replaced;
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  assert.match(
    saved?.content ?? "",
    new RegExp(`saved to ${path.join(directory, files[0] ?? "")}`),
  );
  assert.equal(saved?.is_error, undefined);
  assert.equal(failed?.content, "hook error");
  assert.equal(failed?.is_error, true);
});
