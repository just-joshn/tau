import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { onTestFinished, spyOn, test } from "bun:test";
import { z } from "zod";
import { runAgent } from "../../src/agent.js";
import { AnthropicProvider } from "../../src/provider.js";
import { createTools } from "../../src/tools.js";
import { runCli, type CliRun } from "../helpers/cli-harness.js";
import {
  startMockProvider,
  type ContentBlock,
  type MockProvider,
} from "../helpers/mock-provider.js";
import { fixtureSse } from "../helpers/sse-fixture.js";

// STRATEGY 0.3 and 4: every tool has a versioned request contract. The golden
// file is that contract: each built-in tool's name and input schema exactly as
// the CLI sends them. A reviewer updates it by hand; no test rewrites it.

const GOLDEN = path.join(
  import.meta.dir,
  "../fixtures/tool-schemas.golden.json",
);

const propertySchema = z.looseObject({
  type: z.string().optional(),
  minLength: z.number().optional(),
  maxLength: z.number().optional(),
  maximum: z.number().optional(),
});
const toolSchema = z.object({
  name: z.string(),
  input_schema: z.looseObject({
    properties: z.record(z.string(), propertySchema).optional(),
    required: z.array(z.string()).optional(),
    additionalProperties: z.boolean().optional(),
  }),
});
const goldenSchema = z.object({
  schemaVersion: z.literal(1),
  tools: z.array(toolSchema),
});
type Tool = z.infer<typeof toolSchema>;

const goldenText: unknown = JSON.parse(readFileSync(GOLDEN, "utf8"));
const golden = goldenSchema.parse(goldenText);
// Unparsed schemas, so the comparison sees exactly what the file holds.
const goldenRaw = z
  .object({
    tools: z.array(z.object({ name: z.string(), input_schema: z.unknown() })),
  })
  .parse(goldenText).tools;

// Every built-in tool appears with the todo tools enabled, one skill present,
// and tool search off so deferred tools are sent eagerly with full schemas.
const ALL_TOOLS = {
  env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1", ENABLE_TOOL_SEARCH: "false" },
  files: {
    "present.txt": "present\n",
    ".claude/skills/demo/SKILL.md":
      "---\nname: demo\ndescription: Demo skill.\n---\nBody.\n",
  },
};

const requestSchema = z.object({
  tools: z.array(
    z.looseObject({ name: z.string(), input_schema: z.unknown() }),
  ),
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.array(
        z.looseObject({
          type: z.string(),
          tool_use_id: z.string().optional(),
          is_error: z.boolean().optional(),
          content: z.unknown().optional(),
        }),
      ),
    }),
  ),
});

function request(provider: MockProvider, index: number) {
  return requestSchema.parse(provider.requests[index]?.body);
}

test("tool names and input schemas sent to the API match the reviewed golden file", async () => {
  const provider = await startMockProvider([
    {
      kind: "turn",
      content: [{ type: "text", text: "ok" }],
      stopReason: "end_turn",
    },
  ]);
  const run = await runCli({ args: ["-p", "hi"], provider, ...ALL_TOOLS });
  assert.equal(run.exitCode, 0, run.stderr);
  const actual = request(provider, 0).tools.map(({ name, input_schema }) => ({
    name,
    input_schema,
  }));
  const expected = goldenRaw;
  const names = [...new Set([...expected, ...actual].map((tool) => tool.name))];
  const changes = names.flatMap((name) => {
    const before = expected.find((tool) => tool.name === name);
    const after = actual.find((tool) => tool.name === name);
    const a = JSON.stringify(before?.input_schema);
    const b = JSON.stringify(after?.input_schema);
    return a === b ? [] : [`${name}\n  - golden: ${a}\n  + actual: ${b}`];
  });
  const order =
    JSON.stringify(expected.map((tool) => tool.name)) ===
    JSON.stringify(actual.map((tool) => tool.name))
      ? []
      : [
          `order\n  - golden: ${expected.map((tool) => tool.name).join(",")}\n  + actual: ${actual.map((tool) => tool.name).join(",")}`,
        ];
  assert.deepEqual(
    [...changes, ...order],
    [],
    `Built-in tool schemas sent to the API changed:\n${[...changes, ...order].join("\n")}\n` +
      "This is an API contract change. A reviewer must confirm it and update " +
      "test/fixtures/tool-schemas.golden.json by hand; tests never rewrite it.",
  );
});

// INV-02 matrix. Each base input is valid and, where the tool has a side
// effect, names a "bad-" marker that would only appear if a rejected call ran.
const BASE: Record<string, (tag: string) => Record<string, unknown>> = {
  Read: () => ({ file_path: "present.txt" }),
  Write: (tag) => ({ file_path: `bad-${tag}.txt`, content: "x" }),
  Edit: (tag) => ({
    file_path: `bad-${tag}.txt`,
    old_string: "",
    new_string: "x",
  }),
  Glob: () => ({ pattern: "*.txt" }),
  Grep: () => ({ pattern: "present" }),
  Bash: (tag) => ({ command: `touch bad-${tag}.txt` }),
  NotebookEdit: (tag) => ({
    notebook_path: `bad-${tag}.ipynb`,
    new_source: "x",
  }),
  TaskCreate: () => ({ subject: "bad-task", description: "bad-task" }),
  TaskGet: () => ({ taskId: "1" }),
  TaskUpdate: () => ({ taskId: "1", subject: "bad-task" }),
  TaskList: () => ({}),
  TaskStop: () => ({ task_id: "none" }),
  Agent: () => ({ description: "bad", prompt: "bad" }),
  Skill: () => ({ skill: "demo" }),
};

// Valid calls that prove the side-effect markers work.
const CONTROLS: Array<{ name: string; input: Record<string, unknown> }> = [
  { name: "Write", input: { file_path: "ok-write.txt", content: "x" } },
  {
    name: "Edit",
    input: { file_path: "ok-edit.txt", old_string: "", new_string: "x" },
  },
  { name: "Bash", input: { command: "touch ok-bash.txt" } },
  { name: "TaskCreate", input: { subject: "ok-task", description: "ok-task" } },
];

interface Variant {
  tool: string;
  label: string;
  input: Record<string, unknown>;
}

function wrongValues(schema: z.infer<typeof propertySchema>): unknown[] {
  switch (schema.type) {
    case "string":
      return [123, null];
    case "integer":
      return ["seven", 1.5, null];
    case "number":
      return ["seven", null];
    case "boolean":
      return ["yes", 0];
    case "object":
      return ["x", [1]];
    case "array":
      return ["x", { 0: 1 }];
    default:
      return [42, null];
  }
}

/** {}, wrong types, empty and oversized values, derived from the golden schema. */
function schemaVariants(tool: Tool): Variant[] {
  const base = BASE[tool.name];
  if (base === undefined) throw new Error(`no base input for ${tool.name}`);
  const variants: Variant[] = [];
  const add = (label: string, input: Record<string, unknown>) =>
    variants.push({ tool: tool.name, label, input });
  if ((tool.input_schema.required ?? []).length > 0) add("{}", {});
  for (const [key, schema] of Object.entries(
    tool.input_schema.properties ?? {},
  )) {
    for (const [index, value] of wrongValues(schema).entries())
      add(`${key} wrong type ${index}`, {
        ...base(`${tool.name}-${key}-type${index}`),
        [key]: value,
      });
    if (schema.minLength !== undefined && schema.minLength > 0)
      add(`${key} empty`, { ...base(`${tool.name}-${key}-empty`), [key]: "" });
    if (schema.maxLength !== undefined)
      add(`${key} oversized`, {
        ...base(`${tool.name}-${key}-long`),
        [key]: "a".repeat(schema.maxLength + 1),
      });
    if (schema.maximum !== undefined)
      add(`${key} over maximum`, {
        ...base(`${tool.name}-${key}-max`),
        [key]: schema.maximum + 1,
      });
  }
  return variants;
}

function prototypeVariants(tool: Tool): Variant[] {
  const base = BASE[tool.name];
  if (base === undefined) throw new Error(`no base input for ${tool.name}`);
  const proto: unknown = JSON.parse('{"__proto__":{"polluted":true}}');
  const record = z.record(z.string(), z.unknown()).parse(proto);
  return [
    {
      tool: tool.name,
      label: "__proto__ key",
      input: { ...base(`${tool.name}-proto`), ...record },
    },
    {
      tool: tool.name,
      label: "constructor key",
      input: {
        ...base(`${tool.name}-ctor`),
        constructor: { prototype: { polluted: true } },
      },
    },
  ];
}

function toolUse(variants: readonly Variant[], prefix: string): ContentBlock[] {
  return variants.map((variant, index) => ({
    type: "tool_use",
    id: `toolu_${prefix}_${index}`,
    name: variant.tool,
    input: variant.input,
  }));
}

interface MatrixRun {
  run: CliRun;
  provider: MockProvider;
  results: Map<string, { isError: boolean; content: string }>;
  taskList: string;
  files: string[];
}

/** One CLI run: controls, then every variant, then TaskList, then end. */
async function runMatrix(variants: readonly Variant[]): Promise<MatrixRun> {
  const controls: Variant[] = CONTROLS.map((control) => ({
    tool: control.name,
    label: "control",
    input: control.input,
  }));
  const provider = await startMockProvider([
    {
      kind: "turn",
      content: [...toolUse(controls, "ok"), ...toolUse(variants, "bad")],
      stopReason: "tool_use",
    },
    {
      kind: "turn",
      content: [
        { type: "tool_use", id: "toolu_list", name: "TaskList", input: {} },
      ],
      stopReason: "tool_use",
    },
    {
      kind: "turn",
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
    },
  ]);
  const run = await runCli({
    args: ["-p", "go", "--permission-mode", "bypassPermissions"],
    provider,
    ...ALL_TOOLS,
    deadlineMs: 25_000,
  });
  const results = new Map<string, { isError: boolean; content: string }>();
  for (const index of [1, 2])
    for (const block of request(provider, index).messages.at(-1)?.content ?? [])
      if (block.type === "tool_result" && block.tool_use_id !== undefined)
        results.set(block.tool_use_id, {
          isError: block.is_error === true,
          content: JSON.stringify(block.content),
        });
  return {
    run,
    provider,
    results,
    taskList: results.get("toolu_list")?.content ?? "",
    files: readdirSync(run.cwd, { recursive: true, encoding: "utf8" }),
  };
}

function assertRejected(matrix: MatrixRun, variants: readonly Variant[]) {
  assert.equal(matrix.run.exitCode, 0, matrix.run.stderr);
  const accepted = variants.flatMap((variant, index) =>
    matrix.results.get(`toolu_bad_${index}`)?.isError === true
      ? []
      : [`${variant.tool}: ${variant.label}`],
  );
  assert.deepEqual(accepted, [], "invalid inputs ran instead of failing");
  assert.equal(
    matrix.provider.requests.length,
    3,
    "a rejected call reached the provider",
  );
  assert.equal(matrix.provider.unexpected, 0);
  assert.deepEqual(
    matrix.files.filter((file) => file.startsWith("bad-")),
    [],
    "a rejected call left a side effect",
  );
  assert.doesNotMatch(matrix.taskList, /bad-task/);
  // The valid controls ran, so the markers above can detect a side effect.
  for (const [index, control] of CONTROLS.entries())
    assert.equal(
      matrix.results.get(`toolu_ok_${index}`)?.isError,
      false,
      `control ${control.name} failed`,
    );
  assert.ok(matrix.files.includes("ok-bash.txt"));
  assert.match(matrix.taskList, /ok-task/);
}

// Variants tau accepts today, each a KNOWN-GAP below:
// - src/tool-input.ts normalizeToolInput strips a __proto__ key, and the call
//   then runs with its remaining fields.
// - Write, Edit, Bash and Skill advertise open schemas and their zod schemas
//   (src/tools.ts, src/skill-session.ts) strip unknown keys, so a constructor
//   key is ignored and the call runs; Write creates its file.
// - src/task-runtime.ts coerceTaskCreateInput repairs TaskCreate input: it
//   drops unknown keys and wrong-typed activeForm/metadata, although the
//   advertised schema is strict, then creates the task.
// Agent is handled by its own test because an accepted call starts a subagent.
const ACCEPTED_TODAY = (variant: Variant) =>
  variant.label === "__proto__ key" ||
  (variant.label === "constructor key" &&
    ["Write", "Edit", "Bash", "Skill", "TaskCreate"].includes(variant.tool)) ||
  (variant.tool === "TaskCreate" &&
    /^(activeForm|metadata) wrong type/.test(variant.label));

const allVariants = () =>
  golden.tools
    .flatMap((tool) => [...schemaVariants(tool), ...prototypeVariants(tool)])
    .filter(
      (variant) =>
        !(variant.tool === "Agent" && variant.label.endsWith(" key")),
    );

test("INV-02 every built-in tool rejects {}, wrong types, out-of-range values and unknown keys before any side effect", async () => {
  const variants = allVariants().filter((variant) => !ACCEPTED_TODAY(variant));
  assert.ok(variants.length > 60, `only ${variants.length} variants`);
  assertRejected(await runMatrix(variants), variants);
}, 30_000);

test.failing(
  "KNOWN-GAP INV-02 __proto__ and constructor keys and TaskCreate's mistyped optional fields are rejected before any side effect",
  async () => {
    const variants = allVariants().filter(ACCEPTED_TODAY);
    assertRejected(await runMatrix(variants), variants);
  },
  30_000,
);

// KNOWN-GAP: Agent advertises additionalProperties: false, but
// src/subagent-runtime.ts foregroundAgentInputSchema is a plain z.object that
// strips unknown keys, so the call starts a subagent instead of failing.
test.failing(
  "KNOWN-GAP INV-02 Agent rejects a key its advertised schema forbids before starting a subagent",
  async () => {
    const provider = await startMockProvider([
      {
        kind: "turn",
        content: [
          {
            type: "tool_use",
            id: "toolu_agent",
            name: "Agent",
            input: {
              description: "bad",
              prompt: "bad",
              run_in_background: false,
              constructor: { prototype: { polluted: true } },
            },
          },
        ],
        stopReason: "tool_use",
      },
      {
        kind: "turn",
        content: [{ type: "text", text: "child" }],
        stopReason: "end_turn",
      },
      {
        kind: "turn",
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
      },
    ]);
    const run = await runCli({
      args: ["-p", "go", "--permission-mode", "bypassPermissions"],
      provider,
    });
    assert.equal(run.exitCode, 0, run.stderr);
    const result = request(provider, 1)
      .messages.at(-1)
      ?.content.find((block) => block.tool_use_id === "toolu_agent");
    assert.equal(result?.is_error, true, "Agent accepted an unknown key");
    assert.equal(provider.requests.length, 2, "a subagent made a request");
  },
);

// The same file-tool matrix through the in-process stream parser and tool
// executor, where Object.prototype is observable.
test("INV-02 malformed file-tool inputs through the stream parser fail as tool errors and leave Object.prototype clean", async () => {
  const before = Object.getOwnPropertyNames(Object.prototype).sort();
  const names = new Set(["Read", "Write", "Edit", "Glob", "Grep", "Bash"]);
  const tools = golden.tools.filter((tool) => names.has(tool.name));
  const variants = [
    ...tools.flatMap(schemaVariants),
    ...tools.flatMap(prototypeVariants),
  ];
  const cwd = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "tau-inv02-")),
  );
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, "present.txt"), "present\n");
  const turns = [
    fixtureSse([
      {
        type: "message_start",
        message: {
          role: "assistant",
          content: [],
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      ...toolUse(variants, "bad").flatMap((content_block, index) => [
        { type: "content_block_start", index, content_block },
        { type: "content_block_stop", index },
      ]),
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ]),
    fixtureSse([
      {
        type: "message_start",
        message: {
          role: "assistant",
          content: [],
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "done" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ]),
  ];
  const respond = async (): Promise<Response> =>
    new Response(turns.shift() ?? "", {
      headers: { "content-type": "text/event-stream" },
    });
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(respond, { preconnect: globalThis.fetch.preconnect }),
  );
  const results = new Map<string, boolean>();
  try {
    await runAgent({
      provider: new AnthropicProvider({
        apiKey: "fixture",
        baseUrl: "http://127.0.0.1:9",
        maxRetries: 0,
      }),
      tools: createTools({
        cwd,
        mode: "bypassPermissions",
        approve: async () => true,
      }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      model: "fixture",
      system: "",
      maxTokens: 100,
      maxTurns: 3,
      autoCompact: false,
      signal: new AbortController().signal,
      onEvent: (event) => {
        if (event.type === "tool_result")
          results.set(event.result.tool_use_id, event.result.is_error === true);
      },
    });
  } finally {
    fetchSpy.mockRestore();
  }
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), before);
  assert.equal(Reflect.get({}, "polluted"), undefined);
  // Every schema violation is a tool error. Prototype keys are covered by the
  // KNOWN-GAP above; here they only must not pollute.
  const accepted = variants.flatMap((variant, index) =>
    variant.label.endsWith(" key") || results.get(`toolu_bad_${index}`) === true
      ? []
      : [`${variant.tool}: ${variant.label}`],
  );
  assert.deepEqual(accepted, []);
  assert.equal(results.size, variants.length);
  const markers = readdirSync(cwd).filter(
    (file) => file.startsWith("bad-") && !/(proto|ctor)\.txt$/.test(file),
  );
  assert.deepEqual(markers, []);
});
