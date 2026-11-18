import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "bun:test";
import {
  isNativePromptWireToolSchema,
  mergeNativePromptWireShape,
  nativePromptSnapshotHash,
  planNativePromptSnapshot,
  readNativePromptSnapshot,
  updateNativePromptSnapshotTools,
  NativePromptSnapshotCaptureError,
  type NativePromptFact,
  type NativePromptSnapshotCreation,
  type NativePromptSnapshotHost,
  type NativePromptSnapshotInput,
  type NativePromptSnapshotPayload,
  type NativePromptSnapshotResult,
  type NativePromptToolsInput,
  type NativePromptToolsResult,
} from "../src/native-prompt-snapshot.js";
import { captureNativePersistenceJson } from "../src/native-persistence-events.js";
import {
  isNativeObject,
  type NativeObject,
} from "../src/native-session-codec.js";
const known = <T>(value: T): NativePromptFact<T> => ({
  status: "known",
  value,
});
const unknown = (reason = "unknown actual gate") => ({
  status: "unsupported" as const,
  reason,
});
const prefix = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
function object(value: unknown): NativeObject {
  const result = captureNativePersistenceJson(value);
  assert.ok(isNativeObject(result));
  return result;
}
function row(fields: Partial<NativePromptSnapshotPayload> = {}): NativeObject {
  return object({
    type: "attachment",
    uuid: "11111111-1111-1111-1111-111111111111",
    attachment: {
      type: "prompt_snapshot",
      systemPrompt: ["OLD PROMPT"],
      reminderFold: false,
      echoWireToolInputs: false,
      contextRendering: "announced",
      ...fields,
    },
  });
}
const wireSchema = (name: string, version = 1): NativeObject => ({
  name,
  description: `wire ${version}`,
  input_schema: { type: "object", properties: { actual: { type: "string" } } },
  strict: true,
});
function fixture() {
  const calls: Array<{ name: string; value?: unknown }> = [];
  let count = 0;
  const host: NativePromptSnapshotHost = {
    stamp: (input) => {
      calls.push({ name: "stamp", value: input });
      return {
        uuid: `22222222-2222-2222-2222-${String(++count).padStart(12, "0")}`,
        timestamp: "2026-01-01T00:00:00.000Z",
      };
    },
    owedPrompt: (input) => {
      calls.push({ name: "owed", value: input });
      return known(undefined);
    },
    reminderFold: (value) => {
      calls.push({ name: "fold", value });
      return known(undefined);
    },
    echoWireToolInputs: (value) => {
      calls.push({ name: "echo", value });
      return known(undefined);
    },
    modelEffortAfterText: (value) => {
      calls.push({ name: "model", value });
      return known(false);
    },
    toolSchemaProvenance: (tool) => {
      calls.push({ name: "schema", value: tool.name });
      return known("actual-request-wire-entry");
    },
    noteCopied: (previous, next) => {
      calls.push({ name: "copied", value: [previous.uuid, next.uuid] });
    },
    noteRendered: (hash, sections) => {
      calls.push({ name: "rendered", value: [hash, sections] });
    },
    redescribing: (previous, epoch) => {
      calls.push({
        name: "redescribing",
        value: [previous?.reference.uuid, epoch],
      });
      return known(undefined);
    },
    noteRedescribed: (reference, handed, currentNames) => {
      calls.push({
        name: "redescribed",
        value: { uuid: reference.uuid, handed, currentNames },
      });
    },
  };
  const prompt = (
    extra: Partial<NativePromptSnapshotInput> = {},
  ): NativePromptSnapshotInput => ({
    history: [],
    enabled: known(true),
    replayEnabled: known(true),
    bareFork: false,
    querySource: "sdk",
    systemPrompt: ["LIVE PROMPT"],
    resumeActive: false,
    ...extra,
  });
  const tools = (
    extra: Partial<NativePromptToolsInput> = {},
  ): NativePromptToolsInput => ({
    history: [row()],
    enabled: known(true),
    replayEnabled: known(true),
    bareFork: false,
    querySource: "sdk",
    tools: [],
    removeAbsentToolSearch: known(false),
    ...extra,
  });
  return { host, calls, prompt, tools, stamps: () => count };
}
function resolved(result: NativePromptSnapshotResult) {
  if (result.status !== "resolved") assert.fail(result.reasons.join(";"));
  return result.plan;
}
function creation(
  result: NativePromptToolsResult,
): NativePromptSnapshotCreation {
  assert.equal(result.status, "created");
  if (result.status !== "created") assert.fail("no tool snapshot");
  return result.creation;
}
function required<T>(value: T | undefined): T {
  assert.notEqual(value, undefined);
  if (value === undefined) assert.fail("missing value");
  return value;
}

test("fresh live prompt records an actual stamped ordinary snapshot and native short hash without guessed flags/tools", () => {
  const f = fixture(),
    sections = { rendererOwned: true };
  const plan = resolved(
    planNativePromptSnapshot(
      f.prompt({ turnSections: sections, model: "actual-model" }),
      f.host,
    ),
  );
  assert.equal(plan.source, "live_recorded");
  assert.equal(plan.atRenderPoint, false);
  assert.deepEqual(plan.creation?.record.attachment, {
    type: "prompt_snapshot",
    systemPrompt: ["LIVE PROMPT"],
  });
  assert.equal(plan.creation?.serialization.status, "supported");
  assert.equal(
    plan.snapshotHash,
    createHash("sha256").update("LIVE PROMPT").digest("hex").slice(0, 12),
  );
  assert.equal(
    nativePromptSnapshotHash(["a", "b"]),
    createHash("sha256").update("a\0b").digest("hex").slice(0, 12),
  );
  assert.deepEqual(
    f.calls.map((call) => call.name),
    ["fold", "model", "echo", "stamp", "rendered"],
  );
  assert.equal(f.stamps(), 1);
  assert.ok(Object.isFrozen(plan.creation?.record.attachment.systemPrompt));
});

test("changed live text alone reuses the old snapshot because pinned cNa is false", () => {
  const f = fixture();
  const plan = resolved(
    planNativePromptSnapshot(
      f.prompt({ history: [row()], systemPrompt: ["CHANGED LIVE TEXT"] }),
      f.host,
    ),
  );
  assert.equal(plan.source, "from_snapshot");
  assert.deepEqual(plan.systemPrompt, ["OLD PROMPT"]);
  assert.equal(plan.creation, undefined);
  assert.equal(f.stamps(), 0);
  assert.deepEqual(
    f.calls.map((call) => call.name),
    ["owed"],
  );
});

test("last snapshot parser preserves independent duplicate maps and validates actual wire schemas/CLI identity", () => {
  const schema = wireSchema("Read");
  const history = [
    row({
      tools: [
        { name: "Read", description: "first", schema, server: "actual-server" },
        {
          name: "Read",
          description: "last",
          schema: { guessedInputSchema: true },
        },
        { name: "Other", description: "other" },
      ],
      cliPrefix: prefix,
    }),
  ];
  const state = required(readNativePromptSnapshot(history));
  assert.deepEqual(state.tools, [
    { name: "Read", description: "last", schema, server: "actual-server" },
    { name: "Other", description: "other" },
  ]);
  assert.equal(state.cliPrefix, prefix);
  assert.equal(isNativePromptWireToolSchema(schema), true);
  assert.equal(
    isNativePromptWireToolSchema({ ...schema, defer_loading: true }),
    false,
  );
  assert.equal(
    isNativePromptWireToolSchema({ ...schema, cache_control: null }),
    false,
  );
  assert.equal(isNativePromptWireToolSchema({ type: "object" }), false);
  const malformed = object({
    type: "attachment",
    attachment: {
      type: "prompt_snapshot",
      systemPrompt: ["LAST"],
      reminderFold: "not a boolean",
      leadingTools: [1],
      cliPrefix: "unrecognized prefix",
    },
  });
  const parsed = required(readNativePromptSnapshot([...history, malformed]));
  assert.equal(parsed.reminderFold, undefined);
  assert.equal(parsed.wireShape.leadingTools, undefined);
  assert.equal(parsed.cliPrefix, undefined);
  assert.equal(
    readNativePromptSnapshot([
      ...history,
      object({
        type: "attachment",
        attachment: { type: "prompt_snapshot", systemPrompt: 5 },
      }),
    ]),
    undefined,
  );
});

test("resume, bare-fork and auxiliary reuse saved state without resolving absent session flags", () => {
  for (const extra of [
    { resumeActive: true },
    { bareFork: true },
    { querySource: "summary" },
  ]) {
    const f = fixture();
    f.host.owedPrompt = () => assert.fail("owed should not run");
    f.host.reminderFold = () => assert.fail("session flag should not run");
    const plan = resolved(
      planNativePromptSnapshot(
        f.prompt({
          history: [
            row({
              reminderFold: undefined,
              echoWireToolInputs: undefined,
              contextRendering: undefined,
            }),
          ],
          replayEnabled: unknown(),
          ...extra,
        }),
        f.host,
      ),
    );
    assert.equal(plan.source, "from_snapshot");
    assert.equal(plan.creation, undefined);
    assert.equal(f.stamps(), 0);
  }
  const f = fixture();
  assert.equal(
    resolved(planNativePromptSnapshot(f.prompt({ resumeActive: true }), f.host))
      .source,
    "live_unrecorded",
  );
  assert.equal(
    resolved(planNativePromptSnapshot(f.prompt({ bareFork: true }), f.host))
      .source,
    "live_unrecorded",
  );
  assert.equal(f.stamps(), 0);
});

test("reuse backfills actual absent flags including false while retaining saved tool/prefix/wire state", () => {
  const f = fixture();
  f.host.reminderFold = () => known(false);
  f.host.echoWireToolInputs = () => known(false);
  const old = row({
    reminderFold: undefined,
    echoWireToolInputs: undefined,
    contextRendering: undefined,
    tools: [
      { name: "Read", description: "actual", schema: wireSchema("Read") },
    ],
    cliPrefix: prefix,
    systemTurns: false,
  });
  const plan = resolved(
    planNativePromptSnapshot(
      f.prompt({ history: [old], contextRendering: known("announced") }),
      f.host,
    ),
  );
  assert.equal(plan.source, "from_snapshot");
  assert.deepEqual(plan.creation?.record.attachment, {
    type: "prompt_snapshot",
    systemPrompt: ["OLD PROMPT"],
    tools: [
      { name: "Read", description: "actual", schema: wireSchema("Read") },
    ],
    cliPrefix: prefix,
    reminderFold: false,
    systemTurns: false,
    echoWireToolInputs: false,
    contextRendering: "announced",
  });
  assert.deepEqual(
    f.calls.map((call) => call.name),
    ["owed", "stamp", "copied"],
  );
});

test("owed prompt owns rewritten/render-point state, including a real empty rewrite", () => {
  for (const owed of [[], ["OWED RENDERER BODY"]]) {
    const f = fixture(),
      sections = { actualRenderer: "sections" };
    f.host.owedPrompt = (input) => {
      assert.equal(input.turnSections, sections);
      return known(owed);
    };
    const plan = resolved(
      planNativePromptSnapshot(
        f.prompt({ history: [row()], turnSections: sections }),
        f.host,
      ),
    );
    assert.equal(plan.source, "live_recorded");
    assert.equal(plan.rewritten, true);
    assert.equal(plan.atRenderPoint, true);
    assert.deepEqual(plan.systemPrompt, owed);
    assert.deepEqual(
      f.calls.map((call) => call.name),
      ["stamp", "copied"],
    );
  }
});

test("an explicit render point permits fresh prompt recording, but equal prompt does not claim atRenderPoint", () => {
  for (const body of [["OLD PROMPT"], ["NEW PROMPT"]]) {
    const f = fixture();
    f.host.owedPrompt = () => assert.fail("explicit point skips owed");
    const history = [
      row(),
      object({
        type: "attachment",
        attachment: {
          type: "prompt_render_point",
          cause: "set_model_system_prompt",
        },
      }),
    ];
    const plan = resolved(
      planNativePromptSnapshot(
        f.prompt({ history, systemPrompt: body, model: "actual-model" }),
        f.host,
      ),
    );
    assert.equal(plan.source, "live_recorded");
    assert.equal(plan.atRenderPoint, body[0] !== "OLD PROMPT");
    assert.deepEqual(
      f.calls.map((call) => call.name),
      ["stamp", "copied", "rendered"],
    );
  }
});

test("fresh model/leading tool gates retain full positive fields and actual identity while lower serialization explicitly withholds", () => {
  const f = fixture();
  f.host.modelEffortAfterText = () => known(true);
  f.host.leadingTools = (first) => {
    assert.equal(first, true);
    return known(["Read"]);
  };
  const plan = resolved(
    planNativePromptSnapshot(f.prompt({ model: "actual-model" }), f.host),
  );
  assert.equal(plan.creation?.record.attachment.effortAfterText, true);
  assert.deepEqual(plan.creation?.record.attachment.leadingTools, ["Read"]);
  assert.equal(plan.creation?.serialization.status, "unsupported");
  assert.equal(f.stamps(), 1);
  assert.ok(plan.creation?.record.uuid);
  const state = required(
    readNativePromptSnapshot([object(plan.creation?.record)]),
  );
  assert.equal(state.wireShape.effortAfterText, true);
  assert.deepEqual(state.wireShape.leadingTools, ["Read"]);
});

test("inherited wire shape removes answeredBy and suppresses fresh effort/leading production even for an empty inherited object", () => {
  for (const shape of [
    { systemTurnsAnsweredBy: "actual-host", systemTurns: false },
    {},
  ]) {
    const f = fixture();
    f.host.modelEffortAfterText = () => assert.fail("not a fresh request");
    f.host.leadingTools = () =>
      assert.fail("inherited wire shape suppresses leading callback");
    const plan = resolved(
      planNativePromptSnapshot(
        f.prompt({ model: "actual-model", inheritedWireShape: known(shape) }),
        f.host,
      ),
    );
    assert.equal(
      plan.creation?.record.attachment.systemTurnsAnsweredBy,
      undefined,
    );
    assert.equal(plan.creation?.record.attachment.effortAfterText, undefined);
    assert.equal(plan.creation?.serialization.status, "supported");
  }
});

test("tool growth is sticky, appends new names and replaces only actual handed differing descriptions", () => {
  const f = fixture(),
    old = row({
      tools: [
        {
          name: "Read",
          description: "old",
          schema: wireSchema("Read"),
          server: "old-server",
        },
        { name: "Absent", description: "sticky" },
      ],
    });
  const first = creation(
    updateNativePromptSnapshotTools(
      f.tools({
        history: [old],
        tools: [
          {
            name: "Read",
            description: "changed but not handed",
            schema: wireSchema("Read", 2),
          },
          { name: "New", description: "new", schema: wireSchema("New") },
        ],
      }),
      f.host,
    ),
  );
  assert.deepEqual(
    first.record.attachment.tools?.map((tool) => [tool.name, tool.description]),
    [
      ["Read", "old"],
      ["Absent", "sticky"],
      ["New", "new"],
    ],
  );
  assert.deepEqual(
    f.calls.filter((call) => call.name === "schema").map((call) => call.value),
    ["New"],
  );
  const second = creation(
    updateNativePromptSnapshotTools(
      f.tools({
        history: [object(first.record)],
        handed: { names: ["Read"], epoch: 2 },
        tools: [{ name: "Read", description: "actually handed replacement" }],
      }),
      f.host,
    ),
  );
  assert.deepEqual(second.record.attachment.tools?.[0], {
    name: "Read",
    description: "actually handed replacement",
  });
  assert.deepEqual(
    second.record.attachment.tools?.map((tool) => tool.name),
    ["Read", "Absent", "New"],
  );
  assert.equal(f.calls.at(-1)?.name, "redescribed");
});

test("same description does not refresh schema/server and still reports actual handed/current names without stamping", () => {
  const f = fixture();
  f.host.toolSchemaProvenance = () =>
    assert.fail("ignored schema has no provenance demand");
  const old = row({
    tools: [
      {
        name: "Read",
        description: "old",
        schema: wireSchema("Read"),
        server: "old-server",
      },
      { name: "Absent", description: "sticky" },
    ],
  });
  const result = updateNativePromptSnapshotTools(
    f.tools({
      history: [old],
      handed: { names: ["Read", "Absent"], epoch: 4 },
      tools: [
        {
          name: "Read",
          description: "old",
          schema: wireSchema("Read", 99),
          server: "new-server",
        },
      ],
    }),
    f.host,
  );
  assert.equal(result.status, "unchanged");
  assert.equal(f.stamps(), 0);
  assert.deepEqual(
    f.calls.map((call) => call.name),
    ["redescribed"],
  );
  assert.match(JSON.stringify(f.calls[0]?.value), /currentNames.*Read/);
});

test("only source ToolSearch removal prunes an absent old tool, with its explicit actual gate", () => {
  const old = row({
    tools: [
      { name: "ToolSearch", description: "search" },
      { name: "Absent", description: "sticky" },
    ],
  });
  const f = fixture();
  assert.equal(
    updateNativePromptSnapshotTools(
      f.tools({ history: [old], removeAbsentToolSearch: known(false) }),
      f.host,
    ).status,
    "unchanged",
  );
  const removed = creation(
    updateNativePromptSnapshotTools(
      f.tools({ history: [old], removeAbsentToolSearch: known(true) }),
      f.host,
    ),
  );
  assert.deepEqual(
    removed.record.attachment.tools?.map((tool) => tool.name),
    ["Absent"],
  );
  const g = fixture();
  assert.equal(
    updateNativePromptSnapshotTools(
      g.tools({ history: [old], removeAbsentToolSearch: unknown() }),
      g.host,
    ).status,
    "unsupported",
  );
  assert.equal(g.stamps(), 0);
});

test("Yh merges current admitted flags while old effort/leading remain sticky; CLI prefix remains saved-first", () => {
  const f = fixture(),
    old = row({
      tools: [],
      cliPrefix: prefix,
      systemTurns: true,
      effortAfterText: true,
      leadingTools: ["OLD"],
      systemTurnsAnsweredBy: "old-host",
      projectDocsAsDocuments: true,
    });
  const made = creation(
    updateNativePromptSnapshotTools(
      f.tools({
        history: [old],
        tools: [],
        head: {
          cliPrefix: "new ignored prefix",
          wireShape: {
            systemTurns: false,
            systemTurnsAnsweredBy: "new-host",
            projectDocsAsDocuments: false,
            effortAfterText: false,
            leadingTools: ["NEW"],
          },
        },
      }),
      f.host,
    ),
  );
  assert.equal(made.record.attachment.cliPrefix, prefix);
  assert.equal(made.record.attachment.systemTurns, false);
  assert.equal(made.record.attachment.systemTurnsAnsweredBy, "new-host");
  assert.equal(made.record.attachment.projectDocsAsDocuments, false);
  assert.equal(made.record.attachment.effortAfterText, true);
  assert.deepEqual(made.record.attachment.leadingTools, ["OLD"]);
  assert.equal(made.serialization.status, "unsupported");
  const no = updateNativePromptSnapshotTools(
    f.tools({
      history: [old],
      tools: [],
      head: { wireShape: { effortAfterText: false, leadingTools: ["NEW"] } },
    }),
    f.host,
  );
  assert.equal(no.status, "unchanged");
  assert.deepEqual(
    mergeNativePromptWireShape(
      { systemTurns: true },
      { systemTurns: false },
      known(false),
    ),
    { wireShape: { systemTurns: true }, changed: false },
  );
  assert.equal(
    mergeNativePromptWireShape({}, undefined, unknown()).changed,
    false,
  );
});

test("prompt and tool producer preserve lazy gate boundaries, actual schema provenance and render-point refusal", () => {
  const f = fixture();
  assert.equal(
    planNativePromptSnapshot(f.prompt({ enabled: unknown() }), f.host).status,
    "unsupported",
  );
  assert.equal(f.stamps(), 0);
  assert.equal(
    updateNativePromptSnapshotTools(
      f.tools({ tools: undefined, enabled: unknown() }),
      f.host,
    ).status,
    "unchanged",
  );
  const history = [
    row(),
    object({ type: "attachment", attachment: { type: "prompt_render_point" } }),
  ];
  assert.equal(
    updateNativePromptSnapshotTools(
      f.tools({ history, tools: [{ name: "New", description: "new" }] }),
      f.host,
    ).status,
    "unchanged",
  );
  f.host.toolSchemaProvenance = () => unknown("not the actual request schema");
  const result = updateNativePromptSnapshotTools(
    f.tools({
      tools: [{ name: "New", description: "new", schema: wireSchema("New") }],
    }),
    f.host,
  );
  assert.equal(result.status, "unsupported");
  assert.equal(f.stamps(), 0);
  if (result.status === "unsupported")
    assert.match(result.reasons.join(" "), /actual request schema/);
});

test("tp actual epoch notifications and owner failures remain explicit, with no restamping or quiet fallback", () => {
  const f = fixture();
  f.host.redescribing = (_snapshot, epoch) => known({ names: ["Read"], epoch });
  const plan = resolved(
    planNativePromptSnapshot(f.prompt({ toolDescribeEpoch: 8 }), f.host),
  );
  assert.deepEqual(plan.redescribing, { names: ["Read"], epoch: 8 });
  assert.deepEqual(
    f.calls.map((call) => call.name),
    ["fold", "echo", "stamp", "rendered"],
  );
  const g = fixture();
  g.host.stamp = () => {
    throw new Error("owner stamp failed");
  };
  assert.throws(
    () => planNativePromptSnapshot(g.prompt(), g.host),
    NativePromptSnapshotCaptureError,
  );
  const h = fixture();
  h.host.noteCopied = () => {
    throw new Error("owner transfer failed");
  };
  assert.throws(
    () =>
      updateNativePromptSnapshotTools(
        h.tools({ tools: [{ name: "Read", description: "actual" }] }),
        h.host,
      ),
    NativePromptSnapshotCaptureError,
  );
});

test("inherited session values remain actual and conflicting host resolutions are unsupported without stamping", () => {
  const f = fixture();
  f.host.reminderFold = (inherited) => known(inherited);
  f.host.echoWireToolInputs = (inherited) => known(inherited);
  const plan = resolved(
    planNativePromptSnapshot(
      f.prompt({
        inheritedReminderFold: known(true),
        inheritedEchoWireToolInputs: known(false),
        contextRendering: known("inline"),
      }),
      f.host,
    ),
  );
  assert.equal(plan.creation?.record.attachment.reminderFold, true);
  assert.equal(plan.creation?.record.attachment.echoWireToolInputs, false);
  assert.equal(plan.creation?.record.attachment.contextRendering, "inline");
  assert.equal(plan.creation?.serialization.status, "unsupported");
  const g = fixture();
  g.host.reminderFold = () => known(false);
  assert.equal(
    planNativePromptSnapshot(
      g.prompt({ inheritedReminderFold: known(true) }),
      g.host,
    ).status,
    "unsupported",
  );
  assert.equal(g.stamps(), 0);
  assert.equal(
    isNativePromptWireToolSchema({
      ...wireSchema("Read"),
      cache_control: undefined,
    }),
    false,
  );
});

test("leading-tools production can occur on a writable non-main or later request with firstRequest false", () => {
  for (const extra of [
    { querySource: undefined },
    { querySource: "agent:reader" },
    { history: [object({ type: "assistant" })] },
  ]) {
    const f = fixture();
    f.host.modelEffortAfterText = () =>
      assert.fail("not the first main request");
    f.host.leadingTools = (first) => {
      assert.equal(first, false);
      return known(["ACTUAL LEADING TOOL"]);
    };
    const plan = resolved(
      planNativePromptSnapshot(
        f.prompt({ model: "actual-model", ...extra }),
        f.host,
      ),
    );
    assert.equal(plan.source, "live_recorded");
    assert.deepEqual(plan.creation?.record.attachment.leadingTools, [
      "ACTUAL LEADING TOOL",
    ]);
    assert.equal(plan.creation?.serialization.status, "unsupported");
  }
});

test("complete producer cycle records prompt then actual tools, retains sticky descriptions and cold-resumes the last full snapshot", () => {
  const f = fixture();
  f.host.reminderFold = () => known(false);
  f.host.echoWireToolInputs = () => known(false);
  const first = required(
    resolved(
      planNativePromptSnapshot(
        f.prompt({ contextRendering: known("announced") }),
        f.host,
      ),
    ).creation,
  );
  const requestSchema = wireSchema("Read");
  const second = creation(
    updateNativePromptSnapshotTools(
      f.tools({
        history: [object(first.record)],
        tools: [
          {
            name: "Read",
            description: "initial description",
            schema: requestSchema,
          },
        ],
        head: {
          cliPrefix: prefix,
          wireShape: { systemTurns: false, toolChangeHeader: false },
        },
      }),
      f.host,
    ),
  );
  const third = creation(
    updateNativePromptSnapshotTools(
      f.tools({
        history: [object(first.record), object(second.record)],
        tools: [
          {
            name: "Read",
            description: "handed current description",
            schema: wireSchema("Read", 2),
          },
        ],
        handed: { names: ["Read"], epoch: 3 },
      }),
      f.host,
    ),
  );
  assert.equal(first.serialization.status, "supported");
  assert.equal(second.serialization.status, "supported");
  assert.equal(third.serialization.status, "supported");
  const decoded: unknown = JSON.parse(
    JSON.stringify([first.record, second.record, third.record]),
  );
  assert.ok(Array.isArray(decoded));
  const cold = decoded.map(object);
  const state = required(readNativePromptSnapshot(cold));
  assert.deepEqual(state.systemPrompt, ["LIVE PROMPT"]);
  assert.equal(state.tools[0]?.description, "handed current description");
  assert.equal(state.cliPrefix, prefix);
  const count = f.stamps();
  const resumed = resolved(
    planNativePromptSnapshot(
      f.prompt({
        history: cold,
        systemPrompt: ["UNRELATED LIVE CHANGE"],
        resumeActive: true,
        replayEnabled: unknown(),
      }),
      f.host,
    ),
  );
  assert.equal(resumed.source, "from_snapshot");
  assert.equal(resumed.creation, undefined);
  assert.deepEqual(resumed.systemPrompt, state.systemPrompt);
  assert.deepEqual(resumed.tools, state.tools);
  assert.equal(resumed.recordedWireShape?.systemTurns, false);
  assert.equal(f.stamps(), count);
});

test("owner callbacks cannot retroactively mutate captured prompt/tool/schema production", () => {
  const f = fixture(),
    prompt = ["ACTUAL PROMPT"];
  f.host.stamp = (input) => {
    prompt[0] = "MUTATED OWNER INPUT";
    assert.ok(Object.isFrozen(input.attachment.systemPrompt));
    return {
      uuid: "33333333-3333-3333-3333-333333333333",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
  };
  const plan = resolved(
    planNativePromptSnapshot(f.prompt({ systemPrompt: prompt }), f.host),
  );
  assert.deepEqual(plan.systemPrompt, ["ACTUAL PROMPT"]);
  assert.deepEqual(plan.creation?.record.attachment.systemPrompt, [
    "ACTUAL PROMPT",
  ]);
  const offered = [
    {
      name: "New",
      description: "ACTUAL DESCRIPTION",
      schema: wireSchema("New"),
    },
  ];
  f.host.toolSchemaProvenance = (tool) => {
    offered[0] = {
      name: "New",
      description: "MUTATED DESCRIPTION",
      schema: {},
    };
    assert.ok(Object.isFrozen(tool.schema));
    return known("actual-request-wire-entry");
  };
  const made = creation(
    updateNativePromptSnapshotTools(f.tools({ tools: offered }), f.host),
  );
  assert.equal(
    made.record.attachment.tools?.[0]?.description,
    "ACTUAL DESCRIPTION",
  );
  assert.deepEqual(
    made.record.attachment.tools?.[0]?.schema,
    wireSchema("New"),
  );
});
