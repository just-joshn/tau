import { expect, test } from "bun:test";
import { z } from "zod";
import {
  bindGuardedTool,
  runGuardedTool,
  wrapGuardedTools,
  type GuardedTool,
  type GuardedToolHost,
  type ToolCheck,
} from "../../src/guarded-tool.js";
import type { ToolHookRuntime } from "../../src/tool-hook-runtime.js";
import { toolPolicySchema } from "../../src/tool-policy.js";
import type { ToolExecutor, ToolResult, ToolUse } from "../../src/types.js";

const signal = new AbortController().signal;
const schema = z.object({ n: z.number() });
type Input = z.infer<typeof schema>;

function tool(
  options: {
    check?: ToolCheck;
    run?: () => Promise<string>;
    validate?: (input: Input) => Promise<string | undefined>;
  } = {},
): GuardedTool<Input> {
  return {
    name: "Monitor",
    definition: () => ({
      name: "Monitor",
      description: "d",
      input_schema: { type: "object" },
    }),
    schema: () => schema,
    ...(options.validate === undefined ? {} : { validate: options.validate }),
    check: async () => options.check ?? { behavior: "allow" },
    run: options.run ?? (async () => "ok"),
  };
}
function host(
  overrides: Partial<Omit<GuardedToolHost, "policy">> & {
    policy?: unknown;
  } = {},
): GuardedToolHost {
  const { policy, ...rest } = overrides;
  return {
    mode: () => "default",
    policy: () => toolPolicySchema.parse(policy ?? {}),
    hooks: () => undefined,
    approve: async () => true,
    ...rest,
  };
}
const use = (input: unknown): ToolUse => ({
  type: "tool_use",
  id: "u1",
  name: "Monitor",
  input,
});
function hooks(overrides: Partial<ToolHookRuntime> = {}): ToolHookRuntime {
  return {
    before: async () => ({ additionalContext: [], preventContinuation: false }),
    after: async (_call, result) => result,
    ...overrides,
  };
}
const text = (r: ToolResult) => String(r.content);

test("a tool absent from the allow list or denied is refused by policy", async () => {
  const listed = await runGuardedTool(
    tool(),
    host({ policy: { tools: ["Read"] } }),
    use({ n: 1 }),
    signal,
  );
  expect(listed.is_error).toBe(true);
  expect(text(listed)).toContain("disabled or denied");
  const denied = await runGuardedTool(
    tool(),
    host({ policy: { disallowedTools: ["Monitor"] } }),
    use({ n: 1 }),
    signal,
  );
  expect(text(denied)).toContain("disabled or denied");
  const allowedByList = await runGuardedTool(
    tool(),
    host({ policy: { tools: ["Monitor"] } }),
    use({ n: 1 }),
    signal,
  );
  expect(text(allowedByList)).toBe("ok");
});

test("a pre-aborted signal throws instead of returning a result", async () => {
  const aborted = new AbortController();
  aborted.abort();
  let thrown: unknown;
  try {
    await runGuardedTool(tool(), host(), use({ n: 1 }), aborted.signal);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeDefined();
});

test("a thrown non-Error becomes a generic failure message", async () => {
  const result = await runGuardedTool(
    tool({
      run: async () => {
        throw "boom";
      },
    }),
    host(),
    use({ n: 1 }),
    signal,
  );
  expect(result).toMatchObject({ is_error: true, content: "Monitor failed" });
});

test("ask check prompts; a throwing approver counts as a refusal", async () => {
  const prompts: string[] = [];
  const approved = await runGuardedTool(
    tool({ check: { behavior: "ask", prompt: "Really?" } }),
    host({
      approve: async (p) => {
        prompts.push(p);
        return true;
      },
    }),
    use({ n: 1 }),
    signal,
  );
  expect(text(approved)).toBe("ok");
  expect(prompts).toEqual(["Really?"]);
  const refused = await runGuardedTool(
    tool({ check: { behavior: "ask", prompt: "Really?" } }),
    host({
      approve: async () => {
        throw new Error("no ui");
      },
    }),
    use({ n: 1 }),
    signal,
  );
  expect(refused.is_error).toBe(true);
  expect(text(refused)).toContain("haven't granted");
});

test("an allow rule or bypass mode skips the prompt; an ask rule forces it", async () => {
  let asked = 0;
  const approve = async () => {
    asked++;
    return false;
  };
  const askCheck: ToolCheck = { behavior: "ask", prompt: "p" };
  const viaRule = await runGuardedTool(
    tool({ check: askCheck }),
    host({ approve, policy: { allowedTools: ["Monitor"] } }),
    use({ n: 1 }),
    signal,
  );
  expect(text(viaRule)).toBe("ok");
  const viaMode = await runGuardedTool(
    tool({ check: askCheck }),
    host({ approve, mode: () => "bypassPermissions" }),
    use({ n: 1 }),
    signal,
  );
  expect(text(viaMode)).toBe("ok");
  expect(asked).toBe(0);
  const forced = await runGuardedTool(
    tool({ check: { behavior: "allow" } }),
    host({ approve, policy: { askedTools: ["Monitor"] } }),
    use({ n: 1 }),
    signal,
  );
  expect(forced.is_error).toBe(true);
  expect(asked).toBe(1);
  const denyCheck = await runGuardedTool(
    tool({ check: { behavior: "deny", message: "nope" } }),
    host(),
    use({ n: 1 }),
    signal,
  );
  expect(text(denyCheck)).toContain("nope");
});

test("hook decisions: prevent, deny, defer, allow, ask and updatedInput", async () => {
  const pre = (extra: object) => ({
    additionalContext: [],
    preventContinuation: false,
    ...extra,
  });
  const run = (before: ToolHookRuntime["before"], t = tool(), h = host()) =>
    runGuardedTool(
      t,
      { ...h, hooks: () => hooks({ before }) },
      use({ n: 1 }),
      signal,
    );
  const stopped = await run(async () =>
    pre({ preventContinuation: true, stopReason: "halt" }),
  );
  expect(stopped).toMatchObject({ is_error: true, content: "halt" });
  const stoppedDefault = await run(async () =>
    pre({ preventContinuation: true }),
  );
  expect(text(stoppedDefault)).toBe("Tool call stopped by hook");
  const denied = await run(async () =>
    pre({ permission: "deny", reason: "hook says no" }),
  );
  expect(text(denied)).toContain("hook says no");
  const deferred = await run(async () => pre({ permission: "defer" }));
  expect(text(deferred)).toBe("Tool denied by hook");
  const allowed = await run(
    async () => pre({ permission: "allow" }),
    tool({ check: { behavior: "ask", prompt: "p" } }),
    host({ approve: async () => false }),
  );
  expect(text(allowed)).toBe("ok");
  const asked = await run(
    async () => pre({ permission: "ask" }),
    tool(),
    host({ approve: async () => false }),
  );
  expect(asked.is_error).toBe(true);
  const updated = await run(async () => pre({ updatedInput: { n: 2 } }));
  expect(updated).toMatchObject({
    content: "ok",
    effectiveToolInput: { n: 2 },
  });
  const badUpdate = await run(async () => pre({ updatedInput: { n: "x" } }));
  expect(badUpdate.is_error).toBe(true);
  expect(badUpdate).toMatchObject({ effectiveToolInput: { n: 1 } });
});

test("failure hooks run only after the tool started", async () => {
  const failures: unknown[] = [];
  const h = host({
    hooks: () =>
      hooks({
        failure: async (_c, error) => {
          failures.push(error);
        },
      }),
  });
  await runGuardedTool(
    tool({
      run: async () => {
        throw new Error("late");
      },
    }),
    h,
    use({ n: 1 }),
    signal,
  );
  expect(failures).toHaveLength(1);
  await runGuardedTool(tool(), h, use({ n: "bad" }), signal);
  expect(failures).toHaveLength(1);
});

test("validation refusal, schema errors and unparsed JSON are tool errors", async () => {
  const refused = await runGuardedTool(
    tool({ validate: async () => "not today" }),
    host(),
    use({ n: 1 }),
    signal,
  );
  expect(text(refused)).toBe("<tool_use_error>not today</tool_use_error>");
  const bad = await runGuardedTool(tool(), host(), use({ n: "x" }), signal);
  expect(bad).toMatchObject({ is_error: true, inputRejected: true });
});

test("wrapGuardedTools lists enabled tools and routes calls", async () => {
  const base: ToolExecutor = {
    definitions: [
      { name: "Base", description: "", input_schema: { type: "object" } },
    ],
    execute: async (call) => ({
      type: "tool_result",
      tool_use_id: call.id,
      content: "base",
    }),
  };
  const runner = bindGuardedTool(tool(), host());
  const wrapped = wrapGuardedTools(base, [runner], host());
  expect(wrapped.definitions.map((d) => d.name)).toEqual(["Base", "Monitor"]);
  expect(text(await wrapped.execute(use({ n: 1 }), signal))).toBe("ok");
  expect(
    text(await wrapped.execute({ ...use({}), name: "Base" }, signal)),
  ).toBe("base");
  const hidden = wrapGuardedTools(
    base,
    [runner],
    host({ policy: { disallowedTools: ["Monitor"] } }),
  );
  expect(hidden.definitions.map((d) => d.name)).toEqual(["Base"]);
});
