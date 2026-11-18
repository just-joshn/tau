import assert from "node:assert/strict";
import { test } from "bun:test";
import { z } from "zod";
import {
  normalizeAssistantToolBlocks,
  normalizeAssistantToolCall,
  normalizeEditCallInput,
  normalizeReadCallInput,
  pureToolCallNormalizationBinding,
  toolCallForExecution,
  type ToolCallNormalizationDiagnostic,
} from "../src/tool-call-normalization.js";
import { unparsedToolInput } from "../src/tool-input.js";
import { runAgent } from "../src/agent.js";
import { projectMessages } from "../src/thinking-history.js";
import type { Message, Provider, ToolUse } from "../src/types.js";

const call = (name: string, input: unknown): ToolUse => ({
  type: "tool_use",
  id: "owned-call",
  name,
  input,
});
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;
}
function setField(value: unknown, key: string, next: unknown): void {
  assert.ok(typeof value === "object" && value !== null);
  Reflect.set(value, key, next);
}
const options = { resolveTool: pureToolCallNormalizationBinding };
const edit = {
  file_path: "/owned/fixture",
  old_string: "before",
  new_string: "after-model",
};

test("Edit ingest commits a concrete false while unrelated missing execution defaults stay absent", () => {
  assert.deepEqual(
    normalizeAssistantToolCall(call("Edit", edit), options).input,
    { replace_all: false, ...edit },
  );
  assert.deepEqual(
    normalizeAssistantToolCall(
      call("Read", { file_path: "/owned/fixture" }),
      options,
    ).input,
    { file_path: "/owned/fixture" },
  );
  assert.deepEqual(
    normalizeAssistantToolCall(
      call("Bash", { command: "owned-no-execution" }),
      options,
    ).input,
    { command: "owned-no-execution" },
  );
  assert.equal(
    normalizeAssistantToolCall(
      call("Edit", { ...edit, replace_all: true }),
      options,
    ).input &&
      field(
        normalizeAssistantToolCall(
          call("Edit", { ...edit, replace_all: true }),
          options,
        ).input,
        "replace_all",
      ),
    true,
  );
});

test("Edit aliases, canonical priority and exact boolean strings follow native strict ingest projection", () => {
  const result = normalizeEditCallInput({
    file_path: "/owned/file",
    old_str: "old-alias",
    old_string: "canonical",
    new_str: "new-alias",
    replace_all: "false",
  });
  assert.deepEqual(result, {
    replace_all: false,
    file_path: "/owned/file",
    old_string: "canonical",
    new_string: "new-alias",
  });
  assert.equal(
    normalizeEditCallInput({ ...edit, replace_all: "true" }).replace_all,
    true,
  );
  assert.equal(
    normalizeEditCallInput({ ...edit, file_path: "" }).file_path,
    "",
  );
  assert.throws(() => normalizeEditCallInput({ ...edit, replace_all: "TRUE" }));
});

test("invalid schema input is retained after repair instead of aborting the assistant or inventing defaults", () => {
  const diagnostics: ToolCallNormalizationDiagnostic[] = [];
  const malformed = {
    file_path: "/owned/file",
    old_str: "before",
    unexpected: true,
  };
  const result = normalizeAssistantToolCall(call("Edit", malformed), {
    ...options,
    onDiagnostic: (d) => diagnostics.push(d),
  });
  assert.deepEqual(result.input, malformed);
  assert.notEqual(result.input, malformed);
  assert.ok(typeof result.input === "object" && result.input !== null);
  assert.equal("replace_all" in result.input, false);
  const [diagnostic] = diagnostics;
  assert.ok(diagnostic);
  assert.equal(diagnostic.stage, "normalize");
  assert.equal(diagnostic.errorName, "ZodError");
  assert.ok(diagnostic.issueCodes?.includes("unrecognized_keys"));
});

test("repair and normalization have separate successful assignment boundaries", () => {
  const diagnostics: ToolCallNormalizationDiagnostic[] = [];
  let normalizations = 0;
  const repaired = normalizeAssistantToolCall(
    call("owned", { value: "before" }),
    {
      resolveTool: () => ({
        repair: () => ({ value: "repaired" }),
        normalize(input) {
          setField(input, "value", "partial mutation");
          throw new Error("owned failure");
        },
      }),
      onDiagnostic: (d) => diagnostics.push(d),
    },
  );
  assert.deepEqual(repaired.input, { value: "repaired" });
  const failed = normalizeAssistantToolCall(
    call("owned", { value: "before" }),
    {
      resolveTool: () => ({
        repair(input) {
          setField(input, "value", "partial repair");
          throw new Error("owned repair failure");
        },
        normalize: (input) => {
          normalizations++;
          return input;
        },
      }),
      onDiagnostic: (d) => diagnostics.push(d),
    },
  );
  assert.deepEqual(failed.input, { value: "before" });
  assert.equal(normalizations, 0);
  assert.deepEqual(
    diagnostics.map((d) => d.stage),
    ["normalize", "repair"],
  );
});

test("malformed JSON markers bypass known-tool normalization, while null/empty follow raw ingest", () => {
  let resolutions = 0;
  const o = {
    resolveTool() {
      resolutions++;
      return pureToolCallNormalizationBinding("Edit");
    },
  };
  const bad = normalizeAssistantToolCall(call("Edit", '{"incomplete":'), o);
  assert.deepEqual(unparsedToolInput(bad.input), {
    raw: '{"incomplete":',
    len: 14,
  });
  assert.equal(resolutions, 0);
  for (const input of ["", "null"])
    assert.deepEqual(
      normalizeAssistantToolCall(call("owned", input), {
        resolveTool: () => undefined,
      }).input,
      {},
    );
  assert.equal(
    normalizeAssistantToolCall(call("owned", "42"), {
      resolveTool() {
        throw new Error("scalar must not resolve");
      },
    }).input,
    42,
  );
  assert.throws(
    () => normalizeAssistantToolCall(call("owned", 42), options),
    /string or object/,
  );
});

test("only known available tools normalize, and name healing precedes lookup", () => {
  assert.deepEqual(
    normalizeAssistantToolCall(call("Edit", edit), {
      resolveTool: () => undefined,
    }).input,
    edit,
  );
  const long = "😀".repeat(201);
  let resolved = "";
  const result = normalizeAssistantToolCall(call(long, {}), {
    resolveTool(name) {
      resolved = name;
      return undefined;
    },
  });
  assert.equal(Array.from(result.name).length, 200);
  assert.equal(result.name, resolved);
});

test("Read decimal offset coercion neither inserts defaults nor performs execution validation", () => {
  for (const [offset, expected] of [
    [" +2 ", 2],
    ["-1.5", -1.5],
    ["0", 0],
    ["1e2", "1e2"],
    [".5", ".5"],
    ["Infinity", "Infinity"],
    ["  ", "  "],
  ] as const) {
    assert.deepEqual(normalizeReadCallInput({ file_path: "owned", offset }), {
      file_path: "owned",
      offset: expected,
    });
  }
  assert.deepEqual(normalizeReadCallInput({ file_path: "owned", limit: "2" }), {
    file_path: "owned",
    limit: "2",
  });
});

test("file-dependent Edit normalization is an explicit host transform and never an implicit file read", () => {
  let transforms = 0;
  const input = { ...edit, new_string: "trailing spaces  " };
  assert.equal(normalizeEditCallInput(input).new_string, "trailing spaces  ");
  const normalized = normalizeAssistantToolCall(call("Edit", input), {
    resolveTool: (name) =>
      pureToolCallNormalizationBinding(name, {
        editTransform(value) {
          transforms++;
          return {
            ...value,
            old_string: "host-harmonized-old",
            new_string: value.new_string.trimEnd(),
          };
        },
      }),
  });
  assert.deepEqual(normalized.input, {
    ...edit,
    replace_all: false,
    old_string: "host-harmonized-old",
    new_string: "trailing spaces",
  });
  assert.equal(transforms, 1);
  normalizeAssistantToolCall(call("Edit", { bad: true }), {
    resolveTool: (name) =>
      pureToolCallNormalizationBinding(name, {
        editTransform(value) {
          transforms++;
          return { ...value };
        },
      }),
  });
  assert.equal(transforms, 1);
});

test("raw block and committed input remain independent of execution/hook rewrites", () => {
  const raw = Object.freeze({ ...call("Edit", Object.freeze({ ...edit })) });
  const committed = normalizeAssistantToolCall(raw, options),
    execution = toolCallForExecution(committed);
  setField(execution.input, "new_string", "after-hook");
  assert.deepEqual(raw.input, edit);
  assert.deepEqual(committed.input, { replace_all: false, ...edit });
  const nested = normalizeAssistantToolCall(
    call("owned", { deep: { value: "model" } }),
    { resolveTool: () => undefined },
  );
  const nestedExecution = toolCallForExecution(nested);
  setField(field(nestedExecution.input, "deep"), "value", "hook");
  assert.equal(field(field(nested.input, "deep"), "value"), "model");
  const parsed = normalizeAssistantToolCall(
    call(
      "owned",
      '{"__proto__":{"polluted":true},"nested":{"__proto__":1,"safe":2}}',
    ),
    { resolveTool: () => undefined },
  );
  assert.deepEqual(parsed.input, { nested: { safe: 2 } });
  const probe: Record<string, unknown> = {};
  assert.equal(probe.polluted, undefined);
});

test("mock agent history commits normalized model input before execution defaults and local rewrites", async () => {
  const messages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: "owned normalized workflow" }],
    },
  ];
  const definitions = ["Read", "Edit", "Bash"].map((name) => ({
    name,
    description: "owned fixture",
    input_schema: { type: "object" as const },
  }));
  const calls = [
    call("Read", { file_path: "/owned/file" }),
    call("Edit", edit),
    call("Bash", { command: "owned-command-not-executed" }),
  ].map((value, index) => ({ ...value, id: `owned-call-${index}` }));
  const seen: Record<string, unknown>[] = [],
    requests: Message[][] = [];
  let round = 0;
  const schemas = {
    Read: z.object({ file_path: z.string(), offset: z.number().default(1) }),
    Edit: z.object({
      file_path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
      replace_all: z.boolean().default(false),
    }),
    Bash: z.object({ command: z.string(), timeout: z.number().default(30000) }),
  };
  const provider: Provider = {
    async complete(request) {
      requests.push(structuredClone(request.messages));
      const next = calls[round++];
      return {
        content: next
          ? normalizeAssistantToolBlocks([next], options)
          : [{ type: "text", text: "done" }],
        stop_reason: next ? "tool_use" : "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };
  await runAgent({
    provider,
    tools: {
      definitions,
      async execute(committed) {
        const execution = toolCallForExecution(committed),
          schema: z.ZodType<Record<string, unknown>> | undefined =
            Object.entries(schemas).find(
              ([name]) => name === execution.name,
            )?.[1];
        assert.ok(schema);
        const input = schema.parse(execution.input);
        if (execution.name === "Edit") input.new_string = "after-hook";
        seen.push(input);
        return {
          type: "tool_result",
          tool_use_id: execution.id,
          content: "owned result",
          effectiveToolInput: input,
        };
      },
    },
    messages,
    model: "owned",
    system: "owned",
    maxTokens: 100,
    maxTurns: 4,
    autoCompact: false,
    signal: new AbortController().signal,
    onEvent() {},
  });
  assert.equal(seen[0]?.offset, 1);
  assert.equal(seen[1]?.new_string, "after-hook");
  assert.equal(seen[2]?.timeout, 30000);
  const lastRequest = requests.at(-1);
  assert.ok(lastRequest);
  const wire = projectMessages(lastRequest);
  const history = wire
    .flatMap((m) => m.content)
    .filter((b) => b.type === "tool_use");
  assert.deepEqual(
    history.map((c) => c.input),
    [
      { file_path: "/owned/file" },
      { replace_all: false, ...edit },
      { command: "owned-command-not-executed" },
    ],
  );
});
