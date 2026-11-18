import assert from "node:assert/strict";
import { test } from "bun:test";
import type { HookRegistryLike } from "../../src/composite-hooks.js";
import type {
  HookBatchResult,
  HookInput,
  HookResult,
  HookRunOptions,
} from "../../src/hooks.js";
import { createSessionHookHost } from "../../src/session-hooks.js";
import type { Message, ToolExecutor } from "../../src/types.js";

const signal = () => new AbortController().signal;
const result = (overrides: Partial<HookResult> = {}): HookResult => ({
  id: "hook-1",
  event: "SessionStart",
  origin: { source: "userSettings" },
  command: "hook",
  status: "success",
  stdout: "",
  stderr: "",
  exitCode: 0,
  durationMs: 1,
  ...overrides,
});
const batch = (
  results: HookResult[],
  overrides: Partial<HookBatchResult> = {},
): HookBatchResult => ({
  results,
  background: [],
  additionalContext: [],
  systemMessages: [],
  blockingErrors: [],
  preventContinuation: false,
  cancelled: false,
  watchPaths: [],
  reloadSkills: false,
  ...overrides,
});

/** A registry that answers each run with the batch scripted for its event. */
function scripted(
  answer: (input: HookInput) => HookBatchResult,
  registered: ReturnType<HookRegistryLike["list"]> = [],
) {
  const runs: { input: HookInput; options: HookRunOptions }[] = [];
  let closed = 0;
  const registry: HookRegistryLike = {
    list: (event) =>
      registered.filter(
        (entry) => event === undefined || entry.event === event,
      ),
    run: async (input, options) => {
      runs.push({ input, options });
      return answer(input);
    },
    close: async () => {
      closed++;
    },
  };
  return { registry, runs, closed: () => closed };
}
function host(registry: HookRegistryLike) {
  const diagnostics: string[] = [];
  const created = createSessionHookHost({
    registry,
    context: () => ({
      session_id: "session-1",
      cwd: "/tmp",
      transcript_path: "/tmp/session-1.json",
    }),
    runOptions: () => ({ cwd: "/tmp", projectDir: "/tmp", env: {} }),
    onDiagnostic: (message) => diagnostics.push(message),
  });
  return { host: created, diagnostics };
}
const tools = (): ToolExecutor & { before: number } => {
  const executor = {
    before: 0,
    definitions: [],
    async execute() {
      throw new Error("not called");
    },
    async beforeModelRequest() {
      executor.before++;
    },
  };
  return executor;
};
const texts = (messages: Message[]) =>
  messages.map((message) =>
    message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join(""),
  );

test("SessionStart context reaches the next model request once, in hook order", async () => {
  const { registry, runs } = scripted(() =>
    batch([
      result({
        additionalContext: "extra context",
        initialUserMessage: "first message",
        stdout: "plain stdout\n",
      }),
      result({ stdout: "hidden stdout", suppressOutput: true }),
      result({ stdout: '{"json":"output"}' }),
    ]),
  );
  const { host: session } = host(registry);
  await session.start("resume", signal());
  assert.equal(runs[0]?.input.hook_event_name, "SessionStart");
  assert.equal(runs[0]?.input.source, "resume");
  const messages: Message[] = [],
    base = tools(),
    wrapped = session.wrap(base, messages);
  await wrapped.beforeModelRequest?.(signal());
  await wrapped.beforeModelRequest?.(signal());
  assert.equal(base.before, 2);
  assert.deepEqual(texts(messages), [
    "Session hook context:\nextra context\n\nfirst message\n\nplain stdout",
  ]);
});

test("SessionStart failures and unsupported metadata are reported without adding context", async () => {
  const { registry } = scripted(() =>
    batch([
      result({ status: "error", error: "spawn failed", systemMessage: "note" }),
      result({ status: "blocking", reason: "blocked by policy" }),
      result({ status: "error", additionalContext: "not delivered" }),
      result({ watchPaths: ["/tmp/watch"] }),
      result({ reloadSkills: true }),
      result({ sessionTitle: "" }),
    ]),
  );
  const { host: session, diagnostics } = host(registry);
  await session.start("startup", signal());
  const unsupported =
    "SessionStart requested watch, skill reload or title metadata that this host does not yet apply";
  assert.deepEqual(diagnostics, [
    "note",
    "SessionStart: spawn failed",
    "SessionStart: blocked by policy",
    "SessionStart: hook failed",
    unsupported,
    unsupported,
    unsupported,
  ]);
  const messages: Message[] = [];
  await session.wrap(tools(), messages).beforeModelRequest?.(signal());
  assert.deepEqual(messages, []);
});

test("a SessionStart stop request fails start and every later model request", async () => {
  for (const [stopReason, expected] of [
    ["hook says stop", "hook says stop"],
    [undefined, "SessionStart hook stopped continuation"],
  ] as const) {
    const { registry } = scripted(() =>
      batch([
        result({
          preventContinuation: true,
          ...(stopReason === undefined ? {} : { stopReason }),
        }),
      ]),
    );
    const { host: session } = host(registry);
    await assert.rejects(session.start("startup", signal()), {
      message: expected,
    });
    await assert.rejects(
      session.wrap(tools(), []).beforeModelRequest?.(signal()) ??
        Promise.resolve(),
      { message: expected },
    );
  }
});

test("a cancelled SessionStart or task batch rejects as an abort", async () => {
  const { registry } = scripted(() => batch([], { cancelled: true }));
  const { host: session } = host(registry);
  await assert.rejects(session.start("startup", signal()), {
    name: "AbortError",
  });
  await assert.rejects(
    session.task("TaskCreated", { taskId: "1", subject: "s" }, signal()),
    { name: "AbortError" },
  );
});

test("background SessionStart results arrive as context until the host closes", async () => {
  const { registry, runs, closed } = scripted(() => batch([]));
  const { host: session } = host(registry);
  await session.start("startup", signal());
  const deliver = runs[0]?.options.onBackgroundResult;
  assert.ok(deliver);
  await deliver(result({ additionalContext: "late context" }));
  const messages: Message[] = [];
  await session.wrap(tools(), messages).beforeModelRequest?.(signal());
  assert.deepEqual(texts(messages), ["Session hook context:\nlate context"]);
  await session.close();
  assert.equal(closed(), 1);
  await deliver(result({ additionalContext: "after close" }));
  await session.wrap(tools(), messages).beforeModelRequest?.(signal());
  assert.equal(messages.length, 1);
});

test("background results from tool hooks route SessionStart to context and report others", async () => {
  const { registry, runs } = scripted(() => batch([]));
  const { host: session, diagnostics } = host(registry);
  await session.runtime.before(
    { type: "tool_use", id: "t1", name: "Read", input: {} },
    signal(),
    async (input) => input,
  );
  const deliver = runs[0]?.options.onBackgroundResult;
  assert.ok(deliver);
  await deliver(
    result({ event: "PostToolUse", status: "error", error: "async failed" }),
  );
  await deliver(result({ additionalContext: "rewake context" }));
  assert.deepEqual(diagnostics, ["PostToolUse: async failed"]);
  const messages: Message[] = [];
  await session.wrap(tools(), messages).beforeModelRequest?.(signal());
  assert.deepEqual(texts(messages), ["Session hook context:\nrewake context"]);
});

test("task feedback names the hook command and prefers reason, then error, then stderr", async () => {
  const hook = {
    type: "command" as const,
    command: "check",
    args: ["--strict"],
  };
  const { registry } = scripted(
    () =>
      batch([
        result({
          id: "a",
          event: "TaskCompleted",
          command: "check",
          status: "blocking",
          reason: "needs tests",
        }),
        result({
          id: "b",
          event: "TaskCompleted",
          command: "lint",
          status: "blocking",
          error: "lint crashed",
          stderr: "ignored",
        }),
        result({
          id: "c",
          event: "TaskCompleted",
          command: "lint",
          status: "blocking",
          stderr: "  stderr text \n",
        }),
        result({
          id: "d",
          event: "TaskCompleted",
          command: "lint",
          status: "blocking",
        }),
        result({ id: "e", event: "TaskCompleted", command: "lint" }),
      ]),
    [
      {
        id: "a",
        event: "TaskCompleted",
        origin: { source: "userSettings" },
        hook,
      },
    ],
  );
  const { host: session } = host(registry);
  assert.deepEqual(
    await session.task(
      "TaskCompleted",
      { taskId: "7", subject: "ship" },
      signal(),
    ),
    [
      "TaskCompleted hook feedback:\n[check --strict]: needs tests",
      "TaskCompleted hook feedback:\n[lint]: lint crashed",
      "TaskCompleted hook feedback:\n[lint]: stderr text",
      "TaskCompleted hook feedback:\n[lint]: Blocked by hook",
    ],
  );
});

test("tool hooks are reported present when any tool event has a registration", () => {
  const { registry } = scripted(
    () => batch([]),
    [
      {
        id: "p",
        event: "PostToolUseFailure",
        origin: { source: "userSettings" },
        hook: { type: "command", command: "x" },
      },
    ],
  );
  assert.equal(host(registry).host.hasToolHooks, true);
});
