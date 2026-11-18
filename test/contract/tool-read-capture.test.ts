import assert from "node:assert/strict";
import { test, onTestFinished } from "bun:test";
import { mkdtemp, writeFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTools,
  TextReadCaptureError,
  type TextReadResultCapture,
} from "../../src/tools.js";
import type { ToolHookRuntime } from "../../src/tool-hook-runtime.js";
import type { FilePermissionSessionResult } from "../../src/file-permission-session.js";
import type { PolicyRuleMatch } from "../../src/tool-policy.js";
import type { PermissionMode, ToolUse } from "../../src/types.js";
import { ReadState } from "../../src/read-state.js";
import { projectMessages } from "../../src/thinking-history.js";

const signal = () => new AbortController().signal;
const call = (input: unknown = { file_path: "owned.txt" }): ToolUse => ({
  type: "tool_use",
  id: "owned-read",
  name: "Read",
  input,
});
const pre = () => ({ additionalContext: [], preventContinuation: false });
async function fixture(bytes: string | Buffer = "FIRST\nSECOND\n") {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "tau-text-read-capture-")),
  );
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const file = join(cwd, "owned.txt");
  await writeFile(file, bytes);
  const records: TextReadResultCapture[] = [];
  return {
    cwd,
    file,
    records,
    capture: (record: TextReadResultCapture) => {
      records.push(record);
    },
  };
}
function captured(rows: readonly TextReadResultCapture[]) {
  const row = rows[0];
  assert.ok(row);
  return row;
}
function candidates(
  file: string,
): FilePermissionSessionResult & { compatibilityAllow?: PolicyRuleMatch } {
  return {
    status: "classified",
    canonicalPath: file,
    generation: 7,
    diagnostics: [],
    unsupported: [],
    inspection: {
      status: "resolved",
      requested: file,
      spellings: [file],
      leafIsSymlink: false,
      links: 0,
      landing: file,
      exists: true,
      isDirectory: false,
    },
  };
}
const rule = (
  family: "Read" | "Edit",
  behavior: "allow" | "ask" = "allow",
) => ({
  rule: `${family}(/owned/**)`,
  source: "session",
  behavior,
  origin: "direct" as const,
  family,
  diagnostics: [],
});

test("ordinary capture retains real I/O and raw DTO without hooks or additional returned/API fields", async () => {
  const f = await fixture(Buffer.from("\uFEFFFIRST\r\nSECOND\r\n"));
  const state = new ReadState(),
    modelCall = call();
  const tools = createTools({
    cwd: f.cwd,
    mode: "default",
    readState: state,
    approve: async () => false,
    onTextReadResult: f.capture,
  });
  const result = await tools.execute(modelCall, signal()),
    row = captured(f.records);
  assert.deepEqual(row.rawResult, {
    type: "text",
    file: {
      filePath: "owned.txt",
      content: "FIRST\nSECOND\n",
      numLines: 3,
      startLine: 1,
      totalLines: 3,
    },
  });
  assert.equal(row.canonicalPath, f.file);
  assert.equal(row.selection.lineCount, 3);
  assert.equal(row.selection.text, "FIRST\nSECOND\n");
  assert.equal(row.render.projectionChanged, false);
  assert.equal(row.render.complete, true);
  assert.deepEqual(row.nativeCompatibility, { status: "supported" });
  assert.equal(row.permissionTrace.branch, "readonly");
  assert.equal("permissionDecision" in row.permissionTrace, false);
  assert.deepEqual(row.originalCall, modelCall);
  assert.deepEqual(row.effectiveCall.input, { file_path: f.file });
  assert.deepEqual(row.coreResult, result);
  assert.deepEqual(row.finalResult, result);
  assert.equal(result.hookResponse, undefined);
  assert.deepEqual(Object.keys(result).sort(), [
    "content",
    "tool_use_id",
    "type",
  ]);
  state.requireComplete(f.file);
  const wire = projectMessages([
    { role: "assistant", content: [modelCall] },
    { role: "user", content: [result] },
  ]);
  assert.equal(JSON.stringify(wire).includes("permissionTrace"), false);
  assert.equal(JSON.stringify(wire).includes("canonicalPath"), false);
});

test("snapshots precede Post mutation; the owner callback sees immutable core/final/call values before execute returns", async () => {
  const f = await fixture(),
    events: string[] = [],
    modelCall = call();
  const hooks: ToolHookRuntime = {
    before: async () => {
      events.push("pre");
      return pre();
    },
    after: async (_call, result) => {
      events.push("post");
      return {
        ...result,
        hookAttachments: [
          {
            phase: "post",
            event: "PostToolUse",
            toolName: "Read",
            content: ["POST CONTEXT"],
          },
        ],
      };
    },
  };
  const tools = createTools({
    cwd: f.cwd,
    mode: "default",
    hooks,
    approve: async () => false,
    onFileToolCall: () => {
      events.push("io");
    },
    onTextReadResult: async (row) => {
      events.push("capture");
      f.records.push(row);
      assert.equal(row.coreResult.hookAttachments, undefined);
      assert.deepEqual(row.finalResult.hookAttachments?.[0]?.content, [
        "POST CONTEXT",
      ]);
      assert.ok(Object.isFrozen(row.rawResult.file));
      assert.ok(Object.isFrozen(row.finalResult));
      assert.ok(Object.isFrozen(row.originalCall.input));
      assert.equal(
        Reflect.set(row.rawResult.file, "content", "OWNER MUTATION"),
        false,
      );
      assert.equal(
        Reflect.set(row.finalResult, "content", "OWNER MUTATION"),
        false,
      );
      const input = row.originalCall.input;
      assert.ok(input !== null && typeof input === "object");
      assert.throws(() =>
        Object.assign(input, { file_path: "OWNER MUTATION" }),
      );
      await Promise.resolve();
    },
  });
  const result = await tools.execute(modelCall, signal());
  events.push("returned");
  assert.deepEqual(events, ["pre", "io", "post", "capture", "returned"]);
  assert.match(result.content, /FIRST/);
  assert.deepEqual(modelCall.input, { file_path: "owned.txt" });
  assert.equal(captured(f.records).nativeCompatibility.status, "supported");
});

test("real partial, zero-offset, empty and beyond-EOF counts come from actual selection without guessing completeness", async () => {
  for (const sample of [
    {
      bytes: "A\nB\n",
      input: { file_path: "owned.txt", offset: 0, limit: 1 },
      content: "A",
      lines: 1,
      total: 3,
      start: 0,
    },
    {
      bytes: "A\nB\n",
      input: { file_path: "owned.txt", offset: 2, limit: 1 },
      content: "B",
      lines: 1,
      total: 3,
      start: 2,
    },
    {
      bytes: "",
      input: { file_path: "owned.txt" },
      content: "",
      lines: 1,
      total: 1,
      start: 1,
    },
    {
      bytes: "A\n",
      input: { file_path: "owned.txt", offset: 8 },
      content: "",
      lines: 0,
      total: 2,
      start: 8,
    },
  ]) {
    const f = await fixture(sample.bytes),
      state = new ReadState();
    const tools = createTools({
      cwd: f.cwd,
      mode: "default",
      readState: state,
      approve: async () => false,
      onTextReadResult: f.capture,
    });
    await tools.execute(call(sample.input), signal());
    const row = captured(f.records);
    assert.deepEqual(row.rawResult.file, {
      filePath: "owned.txt",
      content: sample.content,
      numLines: sample.lines,
      totalLines: sample.total,
      startLine: sample.start,
    });
    assert.equal(row.selection.lineCount, sample.lines);
    assert.equal(row.nativeCompatibility.status, "supported");
    if ("offset" in sample.input)
      assert.throws(() => state.requireComplete(f.file));
  }
});

test("actual token pagination retains selected versus projected bodies and explicitly withholds native truncation metadata", async () => {
  const f = await fixture(
      "FIRST LINE LONG CONTENT\nSECOND LINE LONG CONTENT\nTHIRD LINE LONG CONTENT\n",
    ),
    state = new ReadState();
  const tools = createTools({
    cwd: f.cwd,
    mode: "default",
    readState: state,
    fileReadMaxTokens: 3,
    readTokenCounter: async () => 1000,
    approve: async () => false,
    onTextReadResult: f.capture,
  });
  const result = await tools.execute(call(), signal()),
    row = captured(f.records);
  assert.equal(result.is_error, undefined);
  assert.notEqual(row.selection.text, row.render.baseline);
  assert.equal(row.render.projectionChanged, true);
  assert.equal(row.render.complete, false);
  assert.equal(row.nativeCompatibility.status, "unsupported");
  assert.equal("truncatedByTokenCap" in row.rawResult.file, false);
  assert.throws(() => state.requireComplete(f.file));
});

test("pre input rewrite retains model/effective/I/O path facts without claiming native restored-call-input provenance", async () => {
  const f = await fixture();
  const target = join(f.cwd, "target.txt");
  await writeFile(target, "TARGET BODY\n");
  const modelCall = call();
  const hooks: ToolHookRuntime = {
    before: async (_call, _signal, validate) => ({
      ...pre(),
      permission: "allow",
      updatedInput: await validate({ file_path: target }),
    }),
    after: async (_call, result) => result,
  };
  const tools = createTools({
    cwd: f.cwd,
    mode: "default",
    hooks,
    approve: async () => false,
    onTextReadResult: f.capture,
  });
  const result = await tools.execute(modelCall, signal()),
    row = captured(f.records);
  assert.match(result.content, /TARGET BODY/);
  assert.deepEqual(row.originalCall.input, { file_path: "owned.txt" });
  assert.deepEqual(row.effectiveCall.input, { file_path: target });
  assert.equal(row.canonicalPath, target);
  assert.equal(row.rawResult.file.filePath, target);
  assert.equal(row.permissionTrace.branch, "hook");
  assert.equal(row.nativeCompatibility.status, "unsupported");
  assert.deepEqual(modelCall.input, { file_path: "owned.txt" });
});

test("accepted custom Post rewrites and artifact-shaped raw changes retain original I/O separately and report unsupported", async () => {
  const f = await fixture();
  const hooks: ToolHookRuntime = {
    before: async () => pre(),
    after: async (_call, result) => {
      result.content = "POST REPLACED BODY";
      result.hookResponse = {
        type: "text",
        file: { filePath: f.file, content: "POST RAW" },
        artifactRead: { slug: "actual-hook-value", ver: "v1" },
      };
      return result;
    },
  };
  const tools = createTools({
    cwd: f.cwd,
    mode: "default",
    hooks,
    approve: async () => false,
    onTextReadResult: f.capture,
  });
  const result = await tools.execute(call(), signal()),
    row = captured(f.records);
  assert.match(row.coreResult.content, /FIRST/);
  assert.equal(row.rawResult.file.content, "FIRST\nSECOND\n");
  assert.equal(row.finalResult.content, "POST REPLACED BODY");
  assert.equal(result.content, "POST REPLACED BODY");
  assert.equal(row.nativeCompatibility.status, "unsupported");
  assert.match(
    JSON.stringify(row.finalResult.hookResponse),
    /actual-hook-value/,
  );
});

test("permission traces preserve the actual decisive short-circuit and asks rather than deriving a native mode verdict", async () => {
  for (const scenario of [
    "hook",
    "memory",
    "scoped",
    "edit-implies-read",
    "compatibility",
    "readonly",
    "plan",
    "bypass",
    "acceptEdits",
    "approval",
    "file-ask",
  ] as const) {
    const f = await fixture();
    let memoryCalls = 0,
      approvals = 0;
    const file = candidates(f.file);
    if (
      ["hook", "memory", "scoped", "edit-implies-read", "file-ask"].includes(
        scenario,
      )
    )
      file.allow = rule(scenario === "edit-implies-read" ? "Edit" : "Read");
    if (scenario === "compatibility")
      file.compatibilityAllow = { rule: "Read(*)", source: "cliArg" };
    if (scenario === "file-ask") file.ask = rule("Read", "ask");
    const mode: PermissionMode =
      scenario === "plan"
        ? "plan"
        : scenario === "bypass"
          ? "bypassPermissions"
          : scenario === "acceptEdits"
            ? "acceptEdits"
            : "default";
    const hooks: ToolHookRuntime | undefined =
      scenario === "hook" || scenario === "file-ask"
        ? {
            before: async () => ({ ...pre(), permission: "allow" }),
            after: async (_call, result) => result,
          }
        : undefined;
    const tools = createTools({
      cwd: f.cwd,
      mode,
      ...(hooks ? { hooks } : {}),
      policy: {
        allowedTools: ["Read"],
        disallowedTools: [],
        ...(scenario === "approval" ? { askedTools: ["Read"] } : {}),
      },
      filePermissionCandidates: () => file,
      memoryFileAllowance: async () => {
        memoryCalls++;
        return scenario === "hook" || scenario === "memory";
      },
      approve: async () => {
        approvals++;
        return true;
      },
      onTextReadResult: f.capture,
    });
    await tools.execute(call(), signal());
    const trace = captured(f.records).permissionTrace;
    assert.equal(
      trace.branch,
      scenario === "edit-implies-read"
        ? "scoped"
        : ["plan", "bypass", "acceptEdits"].includes(scenario)
          ? "readonly"
          : scenario === "file-ask"
            ? "approval"
            : scenario,
    );
    assert.equal(trace.mode, mode);
    assert.equal(
      trace.asks,
      scenario === "approval" || scenario === "file-ask",
    );
    assert.equal(approvals, trace.branch === "approval" ? 1 : 0);
    assert.equal(memoryCalls, trace.asks ? 0 : 1);
    if (scenario === "edit-implies-read")
      assert.match(trace.matchedRule?.rule ?? "", /^Edit/);
    if (trace.branch === "approval")
      assert.equal(trace.approval?.approved, true);
    assert.equal("permissionDecision" in trace, false);
    assert.ok(Object.isFrozen(trace));
  }
});

test("sink failures are explicit fatal local errors after one successful Post, without failure hooks or false result", async () => {
  const f = await fixture();
  let posts = 0,
    failures = 0,
    captures = 0;
  const reason = new Error("owner recording rejected");
  const hooks: ToolHookRuntime = {
    before: async () => pre(),
    after: async (_call, result) => {
      posts++;
      return result;
    },
    failure: async () => {
      failures++;
    },
  };
  const tools = createTools({
    cwd: f.cwd,
    mode: "default",
    hooks,
    approve: async () => false,
    onTextReadResult: async () => {
      captures++;
      await Promise.resolve();
      throw reason;
    },
  });
  await assert.rejects(
    tools.execute(call(), signal()),
    (error) => error instanceof TextReadCaptureError && error.cause === reason,
  );
  assert.equal(posts, 1);
  assert.equal(failures, 0);
  assert.equal(captures, 1);
});

test("abort during capture preserves the actual abort reason without a failure-hook replay", async () => {
  const f = await fixture(),
    controller = new AbortController(),
    reason = new Error("owned abort");
  let failures = 0;
  const hooks: ToolHookRuntime = {
    before: async () => pre(),
    after: async (_call, result) => result,
    failure: async () => {
      failures++;
    },
  };
  const tools = createTools({
    cwd: f.cwd,
    mode: "default",
    hooks,
    approve: async () => false,
    onTextReadResult: () => {
      controller.abort(reason);
    },
  });
  await assert.rejects(
    tools.execute(call(), controller.signal),
    (error) => error === reason,
  );
  assert.equal(failures, 0);
});

test("failed I/O, denied approval and failed Post retain existing behavior and never announce a successful Read capture", async () => {
  for (const scenario of ["io", "deny", "post"] as const) {
    const f = await fixture();
    let failures = 0;
    const hooks: ToolHookRuntime = {
      before: async () => pre(),
      after: async (_call, result) => {
        if (scenario === "post") throw new Error("Post rejected");
        return result;
      },
      failure: async () => {
        failures++;
      },
    };
    const tools = createTools({
      cwd: f.cwd,
      mode: "default",
      hooks,
      policy: {
        allowedTools: [],
        disallowedTools: [],
        ...(scenario === "deny" ? { askedTools: ["Read"] } : {}),
      },
      approve: async () => false,
      onTextReadResult: f.capture,
    });
    const result = await tools.execute(
      call({ file_path: scenario === "io" ? "missing.txt" : "owned.txt" }),
      signal(),
    );
    assert.equal(result.is_error, true);
    assert.equal(f.records.length, 0);
    assert.equal(failures, scenario === "io" ? 1 : 0);
  }
});

test("optional capture leaves legacy hookResponse/result shape and Read-state behavior unchanged", async () => {
  const f = await fixture(),
    before = new ReadState(),
    after = new ReadState();
  const hooks: ToolHookRuntime = {
    before: async () => pre(),
    after: async (_call, result) => result,
  };
  const plain = createTools({
    cwd: f.cwd,
    mode: "default",
    hooks,
    readState: before,
    approve: async () => false,
  });
  const observed = createTools({
    cwd: f.cwd,
    mode: "default",
    hooks,
    readState: after,
    approve: async () => false,
    onTextReadResult: f.capture,
  });
  assert.deepEqual(
    await observed.execute(call(), signal()),
    await plain.execute(call(), signal()),
  );
  assert.deepEqual(after.candidates(), before.candidates());
  before.requireComplete(f.file);
  after.requireComplete(f.file);
});

test("approval captures the decisive ask candidate before the external approver mutates its live rule objects", async () => {
  const f = await fixture(),
    file = candidates(f.file);
  file.ask = rule("Read", "ask");
  const tools = createTools({
    cwd: f.cwd,
    mode: "default",
    filePermissionCandidates: () => file,
    approve: async () => {
      if (file.ask) file.ask.rule = "MUTATED AFTER ASK";
      return true;
    },
    onTextReadResult: f.capture,
  });
  await tools.execute(call(), signal());
  const trace = captured(f.records).permissionTrace;
  assert.equal(trace.branch, "approval");
  assert.equal(trace.fileCandidates?.ask?.rule, "Read(/owned/**)");
  assert.equal(file.ask.rule, "MUTATED AFTER ASK");
});

test("unrecordable final metadata fails locally after Post and never produces a second tool-failure hook", async () => {
  const f = await fixture();
  let failures = 0;
  const hooks: ToolHookRuntime = {
    before: async () => pre(),
    after: async (_call, result) => ({
      ...result,
      hookResponse: { malformed: () => "not JSON" },
    }),
    failure: async () => {
      failures++;
    },
  };
  const tools = createTools({
    cwd: f.cwd,
    mode: "default",
    hooks,
    approve: async () => false,
    onTextReadResult: f.capture,
  });
  await assert.rejects(tools.execute(call(), signal()), TextReadCaptureError);
  assert.equal(f.records.length, 0);
  assert.equal(failures, 0);
});
