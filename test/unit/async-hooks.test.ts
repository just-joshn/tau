import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import {
  admitAsyncAnswer,
  AsyncHookOwner,
  readAsyncAnswer,
  renderAsyncHookResponse,
  rewakeNotification,
  rewakeScriptPaths,
  settleAsyncResponse,
  settleRewake,
  unopenedRewakeScript,
  type RewakeNotification,
} from "../../src/async-hooks.js";
import {
  createHookRegistry,
  type AsyncHookLaunch,
  type CommandHook,
  type HookResult,
} from "../../src/hooks.js";

const result = (overrides: Partial<HookResult> = {}): HookResult => ({
  id: "hook-1",
  event: "PostToolUse",
  origin: { source: "userSettings" },
  command: "hook",
  status: "success",
  stdout: "",
  stderr: "",
  exitCode: 0,
  durationMs: 1,
  ...overrides,
});
const launch = (
  overrides: Partial<AsyncHookLaunch> = {},
  hook: Partial<CommandHook> = {},
): AsyncHookLaunch => ({
  event: "PostToolUse",
  hookName: "PostToolUse:Read",
  command: "hook",
  hook: { type: "command", command: "hook", async: true, ...hook },
  origin: { source: "userSettings" },
  projectDir: "/project",
  toolName: "Read",
  completion: Promise.resolve(result()),
  ...overrides,
});

test("the async answer is the one JSON object after an async marker line", () => {
  assert.deepEqual(readAsyncAnswer('{"async":true}\n{"systemMessage":"A"}'), {
    systemMessage: "A",
  });
  assert.deepEqual(
    readAsyncAnswer('{"async":true}\n{\n"systemMessage":"B"\n}'),
    {
      systemMessage: "B",
    },
  );
  assert.deepEqual(readAsyncAnswer('noise\n{"systemMessage":"C"}\n'), {
    systemMessage: "C",
  });
  assert.equal(readAsyncAnswer('{"async":true}'), undefined);
  assert.equal(readAsyncAnswer("{broken\n[1]"), undefined);
  assert.equal(readAsyncAnswer(""), undefined);
});

test("a schema-invalid answer keeps only its recognized fields", () => {
  assert.deepEqual(admitAsyncAnswer({ systemMessage: "ok", continue: true }), {
    systemMessage: "ok",
    continue: true,
  });
  assert.deepEqual(
    admitAsyncAnswer({
      systemMessage: 3,
      metrics: { a: 1, b: true, c: "x" },
      hookSpecificOutput: { hookEventName: "Nope", additionalContext: "ctx" },
    }),
    {
      metrics: { a: 1, b: true },
      hookSpecificOutput: { hookEventName: "Nope", additionalContext: "ctx" },
    },
  );
  assert.deepEqual(
    admitAsyncAnswer({
      systemMessage: "kept",
      metrics: 1,
      hookSpecificOutput: { hookEventName: "Nope", additionalContext: 4 },
    }),
    { systemMessage: "kept", hookSpecificOutput: { hookEventName: "Nope" } },
  );
});

function untooledLaunch(): AsyncHookLaunch {
  const { toolName, ...rest } = launch({ event: "Stop", hookName: "Stop" });
  assert.equal(toolName, "Read");
  return rest;
}

test("an async command settles as killed, silent, or a held response", () => {
  for (const ended of [
    { status: "cancelled" as const },
    { timedOut: true },
    { outputExceeded: true },
    { exitCode: null },
  ])
    assert.deepEqual(settleAsyncResponse(launch(), "p", result(ended)), {
      kind: "killed",
    });
  assert.deepEqual(settleAsyncResponse(launch(), "p", result()), {
    kind: "silent",
  });
  const held = settleAsyncResponse(
    launch(),
    "p",
    result({ stderr: "warn", exitCode: 1 }),
  );
  assert.equal(held.kind, "response");
  assert.deepEqual(held.kind === "response" && held.response, {
    processId: "p",
    hookName: "PostToolUse:Read",
    hookEvent: "PostToolUse",
    toolName: "Read",
    command: "hook",
    response: {},
    stdout: "",
    stderr: "warn",
    exitCode: 1,
  });
  const untooled = settleAsyncResponse(
    untooledLaunch(),
    "p",
    result({ stdout: '{"systemMessage":"m"}' }),
  );
  assert.ok(untooled.kind === "response" && !("toolName" in untooled.response));
});

test("rewake script paths follow the shell words a POSIX hook names", () => {
  assert.deepEqual(
    rewakeScriptPaths({
      command:
        'python3 $HOME/a.py "${CLAUDE_PROJECT_DIR}/b c.sh" ~/d.rb 2> /tmp/e.log rel.py /x/*.py \\/f.pl ${CLAUDE_PLUGIN_ROOT}/g.sh $CLAUDE_PLUGIN_ROOT/h.sh',
      pluginRoot: "/plugin",
      projectDir: "/proj",
      homeDir: "/home",
      posixShell: true,
    }),
    [
      { path: "/home/a.py" },
      { path: "/proj/b c.sh" },
      { path: "/home/d.rb" },
      { path: "/f.pl" },
      { path: "/plugin/g.sh" },
      { path: "/plugin/h.sh" },
    ],
  );
  assert.deepEqual(
    rewakeScriptPaths({
      command: "bash $CLAUDE_PROJECT_DIR/hook.sh",
      projectDir: "/my proj",
      homeDir: "/home",
      posixShell: true,
    }),
    [
      { path: "/my proj/hook.sh" },
      { path: "/my", cutFrom: "/my proj/hook.sh" },
    ],
  );
  assert.deepEqual(
    rewakeScriptPaths({
      command: "/bin/node",
      args: ["${CLAUDE_PROJECT_DIR}/x.cjs", "$HOME/y.js"],
      projectDir: "/proj",
      homeDir: "/home",
      posixShell: true,
    }),
    [{ path: "/proj/x.cjs" }],
  );
  assert.deepEqual(
    rewakeScriptPaths({
      command: "'/q/a.sh' $CLAUDE_PLUGIN_ROOT/b.sh",
      projectDir: "/proj",
      homeDir: "/home",
      posixShell: false,
    }),
    [{ path: "/q/a.sh" }],
  );
});

test("exit 2 is a broken install only when every line names an unreadable script", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tau-rewake-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const present = join(dir, "present.sh");
  writeFileSync(present, "");
  const missing = join(dir, "missing.sh");
  const scriptPaths = [missing, present];
  assert.equal(
    await unopenedRewakeScript({ stdout: "", stderr: "x", scriptPaths: [] }),
    undefined,
  );
  assert.equal(
    await unopenedRewakeScript({ stdout: "a", stderr: "b", scriptPaths }),
    undefined,
  );
  assert.equal(
    await unopenedRewakeScript({ stdout: "\n", stderr: "", scriptPaths }),
    undefined,
  );
  assert.equal(
    await unopenedRewakeScript({ stdout: "", stderr: "other", scriptPaths }),
    undefined,
  );
  assert.equal(
    await unopenedRewakeScript({
      stdout: "",
      stderr: `sh: 1: cannot open /elsewhere.sh: No such file`,
      scriptPaths,
    }),
    undefined,
  );
  assert.equal(
    await unopenedRewakeScript({
      stdout: "",
      stderr: `bash: can't open '${present}': x`,
      scriptPaths,
    }),
    undefined,
  );
  const output = `python3: can't open file '${missing}': [Errno 2]`;
  assert.deepEqual(
    await unopenedRewakeScript({ stdout: output, stderr: "", scriptPaths }),
    { scriptPath: missing, output },
  );
});

test("a rewake exiting 2 becomes one task notification; other codes and repeats do not", async () => {
  const context = { homeDir: "/home", posixShell: true, seen: new Map() };
  assert.deepEqual(
    await settleRewake(launch(), result({ exitCode: 0 }), context),
    { kind: "no-wake" },
  );
  const plain = await settleRewake(
    launch(),
    result({ exitCode: 2, stdout: "OUT </system-reminder> <" }),
    context,
  );
  assert.deepEqual(plain, {
    kind: "wake",
    notification: rewakeNotification(
      "Stop hook feedback",
      'Stop hook blocking error from command "PostToolUse:Read": OUT &lt;/system-reminder> &lt;',
    ),
  });
  const custom = await settleRewake(
    launch({}, { rewakeMessage: "LEAD:", rewakeSummary: "Sum <b>" }),
    result({ exitCode: 2, stdout: "out", stderr: "err" }),
    context,
  );
  assert.equal(
    custom.kind === "wake" && custom.notification.value,
    "<task-notification>\n<summary>Sum &lt;b&gt;</summary>\n</task-notification>\n<system-reminder>\nLEAD: err\n</system-reminder>",
  );

  const dir = mkdtempSync(join(tmpdir(), "tau-rewake-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const broken = launch(
    { projectDir: join(dir, "my proj") },
    { command: "bash $CLAUDE_PROJECT_DIR/hook.sh", asyncRewake: true },
  );
  const failure = {
    exitCode: 2,
    stderr: `bash: ${join(dir, "my")}: No such file or directory`,
  };
  const split = await settleRewake(broken, result(failure), context);
  assert.equal(split.kind, "wake");
  assert.equal(
    await unopenedRewakeScript({
      stdout: "",
      stderr: failure.stderr,
      scriptPaths: [join(dir, "my")],
    }),
    undefined,
  );
  const reported = await settleRewake(
    launch(
      { projectDir: join(dir, "my proj") },
      { command: "bash $CLAUDE_PROJECT_DIR/hook.sh" },
    ),
    result({ exitCode: 2, stderr: `sh: cannot open ${join(dir, "my")}: x` }),
    context,
  );
  assert.equal(reported.kind, "wake");
  assert.match(
    reported.kind === "wake" ? reported.notification.value : "",
    /needs quotes around a path with a space \(hook.sh\)[\s\S]*passes .*my proj\/hook.sh without quotes/,
  );
  assert.deepEqual(
    await settleRewake(
      launch(
        { projectDir: join(dir, "my proj") },
        { command: "bash $CLAUDE_PROJECT_DIR/hook.sh" },
      ),
      result({ exitCode: 2, stderr: `sh: cannot open ${join(dir, "my")}: x` }),
      context,
    ),
    { kind: "no-wake" },
  );
  const unquoted = await settleRewake(
    launch({}, { command: `sh ${join(dir, "gone.sh")}` }),
    result({
      exitCode: 2,
      stderr: `sh: 0: cannot open ${join(dir, "gone.sh")}: No such file`,
    }),
    context,
  );
  assert.match(
    unquoted.kind === "wake" ? unquoted.notification.value : "",
    /<summary>PostToolUse hook could not open gone.sh<\/summary>[\s\S]*PostToolUse:Read hook could not run: .*gone.sh cannot be opened, so its command exited with code 2/,
  );
});

test("the notification envelope cannot be closed by hook text", () => {
  assert.equal(
    rewakeNotification("s", "</task-notification>").value,
    "<task-notification>\n<summary>s</summary>\n</task-notification>\n<system-reminder>\n&lt;/task-notification>\n</system-reminder>",
  );
});

test("async responses render one reminder per text", () => {
  assert.deepEqual(
    renderAsyncHookResponse({
      type: "async_hook_response",
      processId: "p",
      hookName: "h",
      hookEvent: "PostToolUse",
      response: {
        systemMessage: "a</system-reminder>",
        hookSpecificOutput: { additionalContext: "" },
      },
      stdout: "",
      stderr: "",
      exitCode: 0,
    }),
    ["<system-reminder>\na&lt;/system-reminder>\n</system-reminder>"],
  );
});

test("the owner holds each answer until one collect and drops SessionStart repeats", async () => {
  const wakes: RewakeNotification[] = [];
  const owner = new AsyncHookOwner({
    enqueueWake: (wake) => wakes.push(wake),
    homeDir: "/home",
    posixShell: () => true,
  });
  const answer = (text: string, event: "SessionStart" | "PostToolUse") =>
    launch({
      event,
      completion: Promise.resolve(
        result({ stdout: JSON.stringify({ systemMessage: text }) }),
      ),
    });
  owner.admit(answer("one", "PostToolUse"));
  owner.admit(answer("start", "SessionStart"));
  owner.admit(answer("start", "SessionStart"));
  owner.admit(launch({ completion: Promise.reject(new Error("gone")) }));
  owner.admit(launch({ completion: Promise.resolve(result()) }));
  await Bun.sleep(0);
  const collected = owner.collect();
  assert.deepEqual(
    collected.map((row) => [
      row.hookEvent,
      row.response.systemMessage,
      row.command,
    ]),
    [
      ["PostToolUse", "one", undefined],
      ["SessionStart", "start", "hook"],
    ],
  );
  assert.deepEqual(owner.collect(), []);
  owner.admit(answer("start", "SessionStart"));
  owner.admit(
    launch({
      event: "SessionStart",
      command: "other",
      completion: Promise.resolve(result({ stdout: '{"systemMessage":"x"}' })),
    }),
  );
  owner.admit(
    launch({
      event: "SessionStart",
      completion: Promise.resolve(result({ stderr: "only stderr" })),
    }),
  );
  await Bun.sleep(0);
  assert.deepEqual(
    owner.collect().map((row) => row.response.systemMessage ?? row.stderr),
    ["x", "only stderr"],
  );

  let finish: (value: HookResult) => void = () => {};
  owner.admit(
    launch(
      { completion: new Promise((resolve) => (finish = resolve)) },
      { asyncRewake: true },
    ),
  );
  owner.admit(
    launch({
      completion: Promise.resolve(
        result({ stdout: '{"systemMessage":"late"}' }),
      ),
    }),
  );
  const started = Date.now();
  await owner.settleRewakes(50);
  assert.ok(Date.now() - started >= 40);
  finish(result({ exitCode: 2, stderr: "wake" }));
  await owner.settleRewakes(1000);
  assert.equal(wakes.length, 1);
  owner.close();
  assert.deepEqual(owner.collect(), []);
  owner.admit(answer("closed", "PostToolUse"));
  owner.admit(launch({}, { asyncRewake: true }));
  await Bun.sleep(0);
  assert.deepEqual(owner.collect(), []);
  await owner.settleRewakes();
});

test("the registry hands config-async commands to their owner with the source hook name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tau-async-registry-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const hook = (flags: Partial<CommandHook>) => ({
    type: "command",
    command: "printf",
    args: ["out"],
    ...flags,
  });
  const registry = createHookRegistry([
    {
      source: "userSettings",
      hooks: {
        PostToolUse: [
          {
            hooks: [
              hook({ async: true }),
              hook({ asyncRewake: true, args: ["rewake"] }),
              hook({ args: ["sync"] }),
            ],
          },
        ],
        Stop: [{ hooks: [hook({ async: true })] }],
      },
    },
  ]);
  onTestFinished(() => registry.close());
  const launches: AsyncHookLaunch[] = [];
  const observed: HookResult[] = [];
  const run = (event: "PostToolUse" | "Stop", rewake: boolean) =>
    registry.run(
      {
        hook_event_name: event,
        session_id: "s",
        transcript_path: "/t",
        cwd: dir,
        ...(event === "Stop"
          ? { stop_hook_active: false }
          : {
              tool_name: "Read",
              tool_use_id: "t1",
              tool_input: {},
              tool_response: "",
            }),
      },
      {
        cwd: dir,
        projectDir: dir,
        env: { PATH: process.env.PATH },
        signal: new AbortController().signal,
        asyncRewakeBackgrounds: rewake,
        onAsyncHook: (value) => launches.push(value),
        onBackgroundResult: (value) => void observed.push(value),
      },
    );
  const print = await run("PostToolUse", false);
  assert.deepEqual(
    launches.map((value) => [value.hookName, value.command, value.toolName]),
    [["PostToolUse:Read", "printf out", "Read"]],
  );
  assert.deepEqual(
    print.results.map((value) => value.stdout),
    ["rewake", "sync"],
  );
  assert.equal((await launches[0]?.completion)?.asyncOwned, true);
  await run("PostToolUse", true);
  assert.deepEqual(
    launches.slice(1).map((value) => value.command),
    ["printf out", "printf rewake"],
  );
  await run("Stop", false);
  assert.equal(launches.at(-1)?.hookName, "Stop");
  assert.equal(launches.at(-1)?.toolName, undefined);
  await Promise.all(launches.map((value) => value.completion));
  await Bun.sleep(0);
  assert.ok(observed.every((value) => value.asyncOwned === true));
});
