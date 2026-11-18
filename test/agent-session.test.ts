import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSessionAgentHost } from "../src/agent-session.js";
import { loadLaunchConfiguration } from "../src/launch-configuration.js";
import { parseOptions } from "../src/options.js";
import { parseToolPolicy } from "../src/tool-policy.js";
import { createTools } from "../src/tools.js";
import type { ToolHookRuntime } from "../src/tool-hook-runtime.js";
import type {
  CompletionRequest,
  PermissionMode,
  Provider,
  ToolUse,
} from "../src/types.js";

async function fixture(t: any) {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "tau-agent-live-policy-")),
  );
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const user = join(cwd, "config"),
    managed = join(cwd, "managed");
  await mkdir(join(user, "agents"), { recursive: true });
  await mkdir(managed);
  await writeFile(
    join(user, "agents", "owned.md"),
    "---\nname: owned\ndescription: Owned live-policy checks\ntools: Read, Write\nmodel: inherit\nmaxTurns: 5\n---\nOWNED_CHILD",
  );
  await writeFile(join(cwd, "private.txt"), "PRIVATE_FILE_CONTENT");
  const env: NodeJS.ProcessEnv = {
    CLAUDE_CONFIG_DIR: user,
    TAU_MANAGED_ROOT: managed,
    CLAUDE_CODE_SUBAGENT_MODEL: "inherit",
    CLAUDE_CODE_FORK_SUBAGENT: "0",
  };
  const options = parseOptions(["--tools", "Agent,Read,Write"]),
    launch = await loadLaunchConfiguration(options, {
      cwd,
      env,
      homeDirectory: cwd,
      nonInteractive: true,
    });
  let policy = parseToolPolicy({ tools: "Agent,Read,Write" }),
    mode: PermissionMode = "default",
    approveCount = 0;
  let onBefore: (call: ToolUse) => void | Promise<void> = () => {};
  let sessionHost:
    Awaited<ReturnType<typeof createSessionAgentHost>> | undefined;
  const notifications: unknown[] = [];
  t.after(async () => sessionHost?.close());
  const hookModes: string[] = [];
  const hooks: ToolHookRuntime = {
    before: async (call) => {
      await onBefore(call);
      return {
        permission: "allow",
        additionalContext: [],
        preventContinuation: false,
      };
    },
    after: async (_call, result) => result,
  };
  const approve = async () => {
    approveCount++;
    return false;
  };
  const setup = async (provider: Provider, background = false) => {
    const host = await createSessionAgentHost({
      cwd,
      launch,
      provider,
      env,
      sessionId: () => "owned-session",
      model: () => "claude-sonnet-4-6",
      policy: () => policy,
      mode: () => mode,
      system: () => "Owned independent system",
      approve,
      hooks,
      childHooks: (plan) => {
        hookModes.push(plan.permissionMode);
        return hooks;
      },
      ...(background
        ? {
            background: {
              outputFile: () => join(cwd, "owned.output"),
              persist: async () => {},
              enqueueNotification: (notification) => {
                notifications.push(notification);
              },
            },
          }
        : {}),
    });
    sessionHost = host;
    return host.wrap(() => createTools({ cwd, policy, mode, approve }));
  };
  return {
    cwd,
    setup,
    setPolicy: (value: typeof policy) => {
      policy = value;
    },
    getPolicy: () => policy,
    setMode: (value: PermissionMode) => {
      mode = value;
    },
    hookModes,
    approveCount: () => approveCount,
    before: (callback: typeof onBefore) => {
      onBefore = callback;
    },
    host: () => sessionHost!,
    notifications,
    env,
  };
}
const call: ToolUse = {
  type: "tool_use",
  id: "agent",
  name: "Agent",
  input: {
    description: "Own task",
    prompt: "Owned task",
    subagent_type: "owned",
    run_in_background: false,
  },
};
const response = (content: any, index: number) => ({
  content: [content],
  stop_reason: content.type === "tool_use" ? "tool_use" : "end_turn",
  usage: { input_tokens: 10, output_tokens: 3 },
  responseId: `live-${index}`,
});
const result = (request: CompletionRequest, id: string) =>
  request.messages
    .flatMap((message) => message.content)
    .find((block) => block.type === "tool_result" && block.tool_use_id === id);

test("child adopts live parent ask, tool availability and mode without losing its isolated query", async (t) => {
  const f = await fixture(t);
  let requests = 0;
  // An allow from a hook never defeats a newly applied explicit parent ask.
  const provider: Provider = {
    async complete(request) {
      requests++;
      if (requests === 1) {
        f.setPolicy({ ...f.getPolicy(), askedTools: ["Read"] });
        return response(
          {
            type: "tool_use",
            id: "asked-read",
            name: "Read",
            input: { file_path: "private.txt" },
          },
          requests,
        );
      }
      if (requests === 2) {
        assert.equal((result(request, "asked-read") as any).is_error, true);
        assert.equal(
          JSON.stringify(result(request, "asked-read")).includes(
            "PRIVATE_FILE_CONTENT",
          ),
          false,
        );
        f.setPolicy({
          ...f.getPolicy(),
          askedTools: [],
          tools: ["Agent", "Write"],
        });
        return response(
          {
            type: "tool_use",
            id: "narrowed-read",
            name: "Read",
            input: { file_path: "private.txt" },
          },
          requests,
        );
      }
      if (requests === 3) {
        assert.equal((result(request, "narrowed-read") as any).is_error, true);
        assert.equal(
          request.tools.some((tool) => tool.name === "Read"),
          false,
        );
        f.setMode("acceptEdits");
        return response(
          {
            type: "tool_use",
            id: "live-write",
            name: "Write",
            input: { file_path: "result.txt", content: "OWNED_WRITE" },
          },
          requests,
        );
      }
      assert.equal((result(request, "live-write") as any).is_error, undefined);
      assert.equal(
        await readFile(join(f.cwd, "result.txt"), "utf8"),
        "OWNED_WRITE",
      );
      return response({ type: "text", text: "child done" }, requests);
    },
  };
  const tools = await f.setup(provider),
    execution = await tools.execute(call, new AbortController().signal);
  assert.equal(execution.is_error, undefined);
  assert.equal(requests, 4);
  assert.equal(f.approveCount(), 1);
  assert.ok(f.hookModes.includes("acceptEdits"));
});

test("a parent policy change during a child Pre hook prevents I/O and permits a later valid retry", async (t) => {
  const f = await fixture(t);
  let first = true,
    requests = 0;
  f.setPolicy({ ...f.getPolicy(), allowedTools: ["Write"] });
  f.before((call) => {
    if (call.name === "Write" && first) {
      first = false;
      f.setPolicy({ ...f.getPolicy(), askedTools: ["Write"] });
    }
  });
  const provider: Provider = {
    async complete(request) {
      requests++;
      if (requests === 2) {
        assert.equal((result(request, "race-write") as any).is_error, true);
        await assert.rejects(readFile(join(f.cwd, "result.txt")), {
          code: "ENOENT",
        });
        f.setPolicy({ ...f.getPolicy(), askedTools: [] });
      }
      if (requests < 3)
        return response(
          {
            type: "tool_use",
            id: requests === 1 ? "race-write" : "retry-write",
            name: "Write",
            input: { file_path: "result.txt", content: "OWNED_RETRY" },
          },
          requests,
        );
      assert.equal((result(request, "retry-write") as any).is_error, undefined);
      return response({ type: "text", text: "done" }, requests);
    },
  };
  const tools = await f.setup(provider),
    execution = await tools.execute(call, new AbortController().signal);
  assert.equal(execution.is_error, undefined);
  assert.equal(requests, 3);
  assert.equal(
    await readFile(join(f.cwd, "result.txt"), "utf8"),
    "OWNED_RETRY",
  );
});

test("a published background child survives parent-turn abort and adopts later asks without opening a prompt", async (t) => {
  const f = await fixture(t);
  let release!: () => void,
    requests = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const provider: Provider = {
    async complete(request) {
      requests++;
      if (requests === 1) {
        await gate;
        assert.equal(request.signal.aborted, false);
        return response(
          {
            type: "tool_use",
            id: "background-asked-read",
            name: "Read",
            input: { file_path: "private.txt" },
          },
          requests,
        );
      }
      assert.equal(
        (result(request, "background-asked-read") as any).is_error,
        true,
      );
      assert.equal(
        JSON.stringify(request.messages).includes("PRIVATE_FILE_CONTENT"),
        false,
      );
      return response({ type: "text", text: "background done" }, requests);
    },
  };
  const tools = await f.setup(provider, true),
    parent = new AbortController();
  const execution = await tools.execute(
    { ...call, input: { ...(call.input as object), run_in_background: true } },
    parent.signal,
  );
  assert.equal(execution.is_error, undefined);
  assert.equal((execution.hookResponse as any).status, "async_launched");
  parent.abort(new Error("parent turn ended"));
  f.setPolicy({ ...f.getPolicy(), askedTools: ["Read"] });
  release();
  await f.host().background!.settled();
  assert.equal(f.host().background!.list()[0]!.status, "completed");
  assert.equal(f.notifications.length, 1);
  assert.equal(f.approveCount(), 0);
  assert.equal(requests, 2);
});

test("concurrency is reserved before child start and released on settlement", async (t) => {
  const f = await fixture(t);
  f.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = " +02 ";
  let release!: () => void,
    requests = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const provider: Provider = {
    async complete() {
      const index = ++requests;
      await gate;
      return response({ type: "text", text: "done" }, index);
    },
  };
  const tools = await f.setup(provider, true),
    signal = new AbortController().signal;
  const launch = (id: string) =>
    tools.execute(
      {
        ...call,
        id,
        input: { ...(call.input as object), run_in_background: true },
      },
      signal,
    );
  assert.equal((await launch("first")).is_error, undefined);
  assert.equal((await launch("second")).is_error, undefined);
  const held = await launch("third");
  assert.equal(held.is_error, true);
  assert.match(held.content, /Concurrent agent limit/);
  assert.equal(f.host().background!.list().length, 2);
  release();
  await f.host().background!.settled();
  assert.equal((await launch("fourth")).is_error, undefined);
  await f.host().background!.settled();
  assert.equal(requests, 3);
});
