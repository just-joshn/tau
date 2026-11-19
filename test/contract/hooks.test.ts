import { test, onTestFinished } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import {
  createHookRegistry,
  DEFAULT_HOOK_TIMEOUT_MS,
  type HookInput,
  type HookSource,
  type HookRunOptions,
} from "../../src/hooks.js";

const loggedRow = z.record(z.string(), z.unknown());
const loggedInput = z.looseObject({
  tool_name: z.string().optional(),
  error: z.string().optional(),
  is_interrupt: z.boolean().optional(),
  duration_ms: z.number().optional(),
});
const at = <T>(items: readonly T[], index: number): T => {
  const item = items[index];
  assert.ok(item !== undefined);
  return item;
};

const script = String.raw`
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
let text='';for await(const part of process.stdin)text+=part;
const input=JSON.parse(text),mode=process.argv[2],log=process.argv[3];
appendFileSync(log,JSON.stringify({input,cwd:process.cwd(),pid:process.pid,args:process.argv.slice(5),env:{project:process.env.CLAUDE_PROJECT_DIR,session:process.env.CLAUDE_CODE_SESSION_ID,plugin:process.env.CLAUDE_PLUGIN_ROOT,effort:process.env.CLAUDE_EFFORT,custom:process.env.FIXTURE_VALUE}})+'\n');
if(mode==='json')process.stdout.write(process.argv[4]);
else if(mode==='plain')process.stdout.write('plain fixture output');
else if(mode==='block'){process.stderr.write('blocked fixture');process.exitCode=2;}
else if(mode==='missing'){process.stderr.write("can't open owned fixture: no such file");process.exitCode=2;}
else if(mode==='fail'){process.stderr.write('failed fixture');process.exitCode=3;}
else if(mode==='wait')setInterval(()=>{},1000);
else if(mode==='descendant'){
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 appendFileSync(log,JSON.stringify({child:child.pid})+'\n');setInterval(()=>{},1000);
}else if(mode==='huge'){process.stdout.write('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\n'+'x'.repeat(8192));}
else if(mode==='touch')writeFileSync(process.argv[4],'ran');
`;

test("subagent command events validate identity, use agent-type matching and retain event-specific context", async () => {
  const f = await fixture();
  onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  const registry = createHookRegistry([
    {
      source: "owned",
      hooks: {
        SubagentStart: [
          {
            matcher: "reader|writer",
            hooks: [
              f.entry("json", {
                hookSpecificOutput: {
                  hookEventName: "SubagentStart",
                  additionalContext: "owned start",
                },
              }),
            ],
          },
        ],
        SubagentStop: [
          {
            matcher: "reader",
            hooks: [
              f.entry("json", {
                continue: false,
                hookSpecificOutput: {
                  hookEventName: "SubagentStop",
                  additionalContext: "owned stop",
                },
              }),
            ],
          },
        ],
      },
    },
  ]);
  onTestFinished(() => registry.close());
  const identity = { agent_id: "child-owned", agent_type: "reader" };
  await assert.rejects(
    registry.run(f.input("SubagentStart"), f.options),
    /agent_id/,
  );
  assert.deepEqual(
    (
      await registry.run(
        f.input("SubagentStart", { ...identity, agent_type: "owned-reader" }),
        f.options,
      )
    ).results,
    [],
  );
  const start = await registry.run(
    f.input("SubagentStart", identity),
    f.options,
  );
  assert.deepEqual(start.additionalContext, ["owned start"]);
  await assert.rejects(
    registry.run(f.input("SubagentStop", identity), f.options),
    /agent_transcript_path/,
  );
  const stop = await registry.run(
    f.input("SubagentStop", {
      ...identity,
      stop_hook_active: true,
      agent_transcript_path: join(f.root, "child.json"),
    }),
    f.options,
  );
  assert.equal(stop.preventContinuation, true);
  assert.deepEqual(stop.additionalContext, ["owned stop"]);
});

test("missing-script exit2 is nonblocking for supported stop/completion events", async () => {
  const f = await fixture();
  onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  const registry = createHookRegistry([
    {
      source: "owned",
      hooks: Object.fromEntries(
        ["Stop", "SubagentStop", "TaskCompleted", "SubagentStart"].map(
          (event) => [event, [{ hooks: [f.entry("missing")] }]],
        ),
      ),
    },
  ]);
  onTestFinished(() => registry.close());
  for (const event of [
    "Stop",
    "SubagentStop",
    "TaskCompleted",
    "SubagentStart",
  ] as const) {
    const batch = await registry.run(
      f.input(event, {
        agent_id: "child-owned",
        agent_type: "reader",
        agent_transcript_path: join(f.root, "child.json"),
        stop_hook_active: false,
        task_id: "1",
        task_subject: "owned",
      }),
      f.options,
    );
    assert.equal(at(batch.results, 0).exitCode, 2);
    assert.equal(
      at(batch.results, 0).status,
      event === "SubagentStart" ? "blocking" : "error",
    );
    assert.equal(
      batch.blockingErrors.length,
      event === "SubagentStart" ? 1 : 0,
    );
  }
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tau-hooks-")));
  const file = join(root, "hook.mjs"),
    log = join(root, "log.jsonl");
  await writeFile(file, script);
  const entry = (
    mode: string,
    output?: unknown,
    extras: Record<string, unknown> = {},
  ) => ({
    type: "command",
    command: process.execPath,
    args: [
      file,
      mode,
      log,
      typeof output === "string" ? output : JSON.stringify(output ?? {}),
    ],
    ...extras,
  });
  const options: HookRunOptions = {
    cwd: root,
    projectDir: root,
    env: { PATH: process.env.PATH, FIXTURE_VALUE: "dummy" },
    signal: new AbortController().signal,
    defaultTimeoutMs: 3000,
    maxOutputBytes: 64 * 1024,
  };
  const input = (
    event: HookInput["hook_event_name"] = "PreToolUse",
    extra: Partial<HookInput> = {},
  ): HookInput => ({
    hook_event_name: event,
    session_id: "fixture-session",
    transcript_path: join(root, "transcript.jsonl"),
    cwd: root,
    ...(event === "PreToolUse" ||
    event === "PostToolUse" ||
    event === "PostToolUseFailure"
      ? {
          tool_name: "Write",
          tool_input: { file_path: "original", content: "original" },
          tool_use_id: "tool-1",
        }
      : {}),
    ...(event === "PostToolUse"
      ? { tool_response: { content: "old output" } }
      : {}),
    ...(event === "PostToolUseFailure"
      ? { error: "owned tool failed", is_interrupt: false }
      : {}),
    ...(event === "Stop" ? { stop_hook_active: false } : {}),
    ...(event === "SessionStart" ? { source: "startup" } : {}),
    ...extra,
  });
  const source = (
    event: HookInput["hook_event_name"],
    hook: unknown,
    matcher?: string,
    source = "userSettings",
  ): HookSource => ({
    source,
    hooks: {
      [event]: [
        { ...(matcher !== undefined ? { matcher } : {}), hooks: [hook] },
      ],
    },
  });
  return {
    root,
    file,
    log,
    entry,
    options,
    input,
    source,
    async rows() {
      try {
        return (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => loggedRow.parse(JSON.parse(line)));
      } catch {
        return [];
      }
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("command hook receives newline JSON stdin, explicit cwd/environment and effort", async () => {
  const f = await fixture(),
    registry = createHookRegistry([
      f.source("PreToolUse", f.entry("plain"), "^Write$"),
    ]);
  try {
    const result = await registry.run(
      f.input("PreToolUse", { effort: { level: "high" } }),
      f.options,
    );
    assert.equal(result.results[0]?.stdout, "plain fixture output");
    assert.equal(result.results[0]?.status, "success");
    const row = at(await f.rows(), 0);
    assert.equal(row.cwd, f.root);
    assert.deepEqual(row.env, {
      project: f.root,
      session: "fixture-session",
      effort: "high",
      custom: "dummy",
    });
    assert.equal(loggedInput.parse(row.input).tool_name, "Write");
    assert.equal(DEFAULT_HOOK_TIMEOUT_MS, 600000);
  } finally {
    await registry.close();
    await f.close();
  }
});

test("PostToolUseFailure matches the failed tool and serializes validated failure fields", async () => {
  const f = await fixture(),
    registry = createHookRegistry([
      f.source("PostToolUseFailure", f.entry("plain"), "^Write$"),
      f.source(
        "PostToolUseFailure",
        f.entry("touch", join(f.root, "wrong-match")),
        "^Read$",
      ),
    ]);
  try {
    const batch = await registry.run(
      f.input("PostToolUseFailure", {
        error: "owned failure",
        is_interrupt: true,
        duration_ms: 12.5,
      }),
      f.options,
    );
    assert.equal(batch.results.length, 1);
    const input = loggedInput.parse(at(await f.rows(), 0).input);
    assert.equal(input.error, "owned failure");
    assert.equal(input.is_interrupt, true);
    assert.equal(input.duration_ms, 12.5);
    assert.equal(Object.hasOwn(input, "tool_response"), false);
    const missing = f.input("PostToolUseFailure");
    delete missing.error;
    await assert.rejects(
      registry.run(missing, f.options),
      /requires error text/,
    );
    const invalidExtras: Record<string, unknown>[] = [
      { is_interrupt: "false" },
      { duration_ms: "12" },
      { duration_ms: Infinity },
    ];
    for (const extra of invalidExtras) {
      await assert.rejects(
        registry.run({ ...f.input("PostToolUseFailure"), ...extra }, f.options),
        /must be/,
      );
    }
    assert.equal((await f.rows()).length, 1, "invalid input starts no command");
  } finally {
    await registry.close();
    await f.close();
  }
});

test("failure hook blocks are feedback and ordinary command errors follow onFailure policy", async () => {
  const f = await fixture();
  try {
    for (const [mode, extras, status] of [
      ["block", {}, "blocking"],
      ["fail", {}, "error"],
      ["fail", { onFailure: "block" }, "blocking"],
      ["json", {}, "blocking"],
    ] as const) {
      const registry = createHookRegistry([
        f.source(
          "PostToolUseFailure",
          f.entry(
            mode,
            { decision: "block", reason: "owned feedback" },
            extras,
          ),
        ),
      ]);
      try {
        const batch = await registry.run(
          f.input("PostToolUseFailure"),
          f.options,
        );
        assert.equal(batch.results[0]?.status, status);
        assert.equal(
          batch.blockingErrors.length,
          status === "blocking" ? 1 : 0,
        );
        assert.equal(
          batch.permission,
          undefined,
          "failure blocks cannot grant or deny a future tool call",
        );
      } finally {
        await registry.close();
      }
    }
  } finally {
    await f.close();
  }
});

test("failure-specific output exposes context without input/output or permission rewrites", async () => {
  const f = await fixture(),
    registry = createHookRegistry([
      f.source(
        "PostToolUseFailure",
        f.entry("json", {
          continue: false,
          stopReason: "raw continuation flag",
          hookSpecificOutput: {
            hookEventName: "PostToolUseFailure",
            additionalContext: "retry with another path",
            permissionDecision: "allow",
            updatedInput: { file_path: "other" },
            updatedToolOutput: "replacement",
          },
        }),
      ),
    ]);
  try {
    const batch = await registry.run(f.input("PostToolUseFailure"), f.options);
    assert.deepEqual(batch.additionalContext, ["retry with another path"]);
    assert.equal(batch.permission, undefined);
    assert.equal(batch.updatedInput, undefined);
    assert.equal(batch.updatedToolOutput, undefined);
    assert.equal(
      batch.preventContinuation,
      true,
      "registry retains raw flags for source-aware consumers",
    );
  } finally {
    await registry.close();
    await f.close();
  }
});

test("asynchronous failure hooks do not block the waiting tool through onFailure", async () => {
  const f = await fixture(),
    registry = createHookRegistry([
      f.source(
        "PostToolUseFailure",
        f.entry("fail", undefined, { async: true, onFailure: "block" }),
      ),
    ]);
  try {
    const batch = await registry.run(f.input("PostToolUseFailure"), f.options);
    assert.deepEqual(batch.blockingErrors, []);
    assert.deepEqual(batch.additionalContext, []);
    assert.equal(batch.results.length, 0);
    assert.equal(batch.background.length, 1);
    assert.equal((await at(batch.background, 0).completion).status, "error");
  } finally {
    await registry.close();
    await f.close();
  }
});

test("regex matchers use tool_name/session source, Stop ignores matcher and invalid tool regex does not run", async () => {
  const f = await fixture();
  const registry = createHookRegistry([
    f.source("PreToolUse", f.entry("plain"), "^Read$"),
    f.source("PostToolUse", f.entry("plain"), "Write|Edit"),
    f.source("Stop", f.entry("plain"), "[invalid"),
    f.source("SessionStart", f.entry("plain"), "resume"),
  ]);
  try {
    assert.equal((await registry.run(f.input(), f.options)).results.length, 0);
    assert.equal(
      (await registry.run(f.input("PostToolUse"), f.options)).results.length,
      1,
    );
    assert.equal(
      (
        await registry.run(
          f.input("Stop", { stop_hook_active: true }),
          f.options,
        )
      ).results.length,
      1,
    );
    assert.equal(
      (await registry.run(f.input("SessionStart"), f.options)).results.length,
      0,
    );
    assert.equal(
      (
        await registry.run(
          f.input("SessionStart", { source: "resume" }),
          f.options,
        )
      ).results.length,
      1,
    );
  } finally {
    await registry.close();
    await f.close();
  }
});

test("PreToolUse rewrites are full replacements and pass the caller validation seam", async () => {
  const f = await fixture();
  const registry = createHookRegistry([
    f.source(
      "PreToolUse",
      f.entry("json", {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "fixture approval",
          updatedInput: { file_path: "replacement", content: "new" },
          additionalContext: "fixture context",
        },
      }),
    ),
  ]);
  try {
    let checked = 0;
    const result = await registry.run(f.input(), {
      ...f.options,
      validateUpdatedInput: (input, context) => {
        checked++;
        assert.equal(context.input.tool_name, "Write");
        assert.equal(input.file_path, "replacement");
        return input;
      },
    });
    assert.equal(result.permission, "allow");
    assert.equal(result.reason, "fixture approval");
    assert.deepEqual(result.updatedInput, {
      file_path: "replacement",
      content: "new",
    });
    assert.deepEqual(result.additionalContext, ["fixture context"]);
    assert.equal(checked, 1);
  } finally {
    await registry.close();
    await f.close();
  }
});

test("an invalid or unavailable rewrite validator refuses the call instead of granting stale input", async () => {
  const f = await fixture();
  const registry = createHookRegistry([
    f.source(
      "PreToolUse",
      f.entry("json", {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { bad: true },
        },
      }),
    ),
  ]);
  try {
    for (const validateUpdatedInput of [
      undefined,
      () => {
        throw new Error("fixture tool schema rejected");
      },
      () => undefined,
    ]) {
      const result = await registry.run(f.input(), {
        ...f.options,
        ...(validateUpdatedInput ? { validateUpdatedInput } : {}),
      });
      assert.equal(result.permission, "deny");
      assert.equal(result.results[0]?.status, "blocking");
      assert.equal(result.updatedInput, undefined);
    }
  } finally {
    await registry.close();
    await f.close();
  }
});

test("deny/ask/defer and legacy block are retained with feedback; denied rewrites are not applied", async () => {
  const f = await fixture();
  try {
    for (const permissionDecision of ["deny", "ask", "defer"] as const) {
      const registry = createHookRegistry([
        f.source(
          "PreToolUse",
          f.entry("json", {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision,
              permissionDecisionReason: "reason",
            },
          }),
        ),
      ]);
      try {
        assert.equal(
          (await registry.run(f.input(), f.options)).permission,
          permissionDecision,
        );
      } finally {
        await registry.close();
      }
    }
    const registry = createHookRegistry([
      f.source(
        "PreToolUse",
        f.entry("json", {
          decision: "block",
          reason: "legacy",
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            updatedInput: { bad: true },
          },
        }),
      ),
    ]);
    const result = await registry.run(f.input(), f.options);
    assert.equal(result.permission, "deny");
    assert.deepEqual(result.blockingErrors, ["legacy"]);
    assert.equal(result.updatedInput, undefined);
    await registry.close();
  } finally {
    await f.close();
  }
});

test("PostToolUse and Stop preserve contextual results without pretending to undo a completed tool", async () => {
  const f = await fixture();
  const registry = createHookRegistry([
    f.source(
      "PostToolUse",
      f.entry("json", {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: "post feedback",
          updatedToolOutput: { content: "new" },
        },
      }),
    ),
    f.source(
      "Stop",
      f.entry("json", {
        decision: "block",
        reason: "continue work",
        continue: false,
        stopReason: "halt reason",
        hookSpecificOutput: {
          hookEventName: "Stop",
          additionalContext: "non-error feedback",
        },
      }),
    ),
  ]);
  try {
    const post = await registry.run(f.input("PostToolUse"), f.options);
    assert.deepEqual(post.updatedToolOutput, { content: "new" });
    assert.deepEqual(post.additionalContext, ["post feedback"]);
    assert.equal(post.permission, undefined);
    const stop = await registry.run(f.input("Stop"), f.options);
    assert.deepEqual(stop.blockingErrors, ["continue work"]);
    assert.equal(stop.preventContinuation, true);
    assert.equal(stop.stopReason, "halt reason");
    assert.deepEqual(stop.additionalContext, ["non-error feedback"]);
  } finally {
    await registry.close();
    await f.close();
  }
});

test("SessionStart JSON returns context/title/initial message and project startup is backgrounded", async () => {
  const f = await fixture();
  const registry = createHookRegistry([
    f.source(
      "SessionStart",
      f.entry("json", {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: "startup context",
          initialUserMessage: "initial",
          sessionTitle: "title",
          watchPaths: ["src"],
          reloadSkills: true,
        },
      }),
      undefined,
      "projectSettings",
    ),
  ]);
  try {
    const background = await registry.run(f.input("SessionStart"), f.options);
    assert.equal(background.results.length, 0);
    assert.equal(background.background.length, 1);
    assert.equal(
      (await at(background.background, 0).completion).additionalContext,
      "startup context",
    );
    const sync = await registry.run(f.input("SessionStart"), {
      ...f.options,
      forceSyncExecution: true,
    });
    assert.deepEqual(sync.additionalContext, ["startup context"]);
    assert.equal(sync.initialUserMessage, "initial");
    assert.equal(sync.sessionTitle, "title");
    assert.deepEqual(sync.watchPaths, ["src"]);
    assert.equal(sync.reloadSkills, true);
  } finally {
    await registry.close();
    await f.close();
  }
});

test("same command identity is deduped per source and once is not resurrected by another matcher", async () => {
  const f = await fixture(),
    hook = f.entry("plain", undefined, { once: true });
  const registry = createHookRegistry([
    {
      source: "userSettings",
      hooks: {
        PreToolUse: [
          { matcher: "Write", hooks: [hook] },
          { matcher: ".*", hooks: [hook] },
        ],
      },
    },
  ]);
  try {
    assert.equal((await registry.run(f.input(), f.options)).results.length, 1);
    assert.equal((await registry.run(f.input(), f.options)).results.length, 0);
    assert.equal((await f.rows()).length, 1);
  } finally {
    await registry.close();
    await f.close();
  }
});

test("exit2 blocks, ordinary failures continue, onFailure block applies before tools but is ignored on Stop", async () => {
  const f = await fixture();
  try {
    for (const [event, mode, onFailure, expected] of [
      ["PreToolUse", "block", "continue", "blocking"],
      ["PreToolUse", "fail", "continue", "error"],
      ["PreToolUse", "fail", "block", "blocking"],
      ["Stop", "fail", "block", "error"],
    ] as const) {
      const registry = createHookRegistry([
        f.source(event, f.entry(mode, undefined, { onFailure })),
      ]);
      try {
        const result = await registry.run(f.input(event), f.options);
        assert.equal(result.results[0]?.status, expected);
        assert.equal(
          result.permission,
          event === "PreToolUse" && expected === "blocking"
            ? "deny"
            : undefined,
        );
      } finally {
        await registry.close();
      }
    }
  } finally {
    await f.close();
  }
});

test("timeout and capture bounds never turn partial stdout into a grant", async () => {
  const f = await fixture();
  const registry = createHookRegistry([
    f.source(
      "PreToolUse",
      f.entry("wait", undefined, { timeout: 0.2, onFailure: "block" }),
    ),
  ]);
  const huge = createHookRegistry([f.source("PreToolUse", f.entry("huge"))]);
  try {
    const timeout = await registry.run(f.input(), f.options);
    assert.equal(timeout.results[0]?.timedOut, true);
    assert.equal(timeout.permission, "deny");
    const capped = await huge.run(f.input(), {
      ...f.options,
      maxOutputBytes: 128,
    });
    assert.equal(capped.results[0]?.outputExceeded, true);
    assert.equal(capped.results[0]?.status, "error");
    assert.equal(capped.permission, undefined);
  } finally {
    await registry.close();
    await huge.close();
    await f.close();
  }
});

test("cancellation before spawn has no effects and active cancellation kills the hook process group", async () => {
  const f = await fixture(),
    registry = createHookRegistry([
      f.source("PreToolUse", f.entry("descendant")),
    ]);
  try {
    const pre = new AbortController();
    pre.abort();
    assert.equal(
      (await registry.run(f.input(), { ...f.options, signal: pre.signal }))
        .cancelled,
      true,
    );
    assert.equal((await f.rows()).length, 0);
    const controller = new AbortController(),
      promise = registry.run(f.input(), {
        ...f.options,
        signal: controller.signal,
      });
    let child: number | undefined;
    for (let count = 0; count < 100; count++) {
      const logged = (await f.rows()).find(
        (row) => typeof row.child === "number",
      );
      child = typeof logged?.child === "number" ? logged.child : undefined;
      if (child) break;
      await sleep(20);
    }
    assert.ok(child);
    controller.abort();
    const result = await promise;
    assert.equal(result.cancelled, true);
    assert.equal(result.results[0]?.status, "cancelled");
    for (let count = 0; count < 30; count++) {
      try {
        process.kill(child, 0);
      } catch {
        child = undefined;
        break;
      }
      await sleep(10);
    }
    assert.equal(child, undefined);
  } finally {
    await registry.close();
    await f.close();
  }
});

test("exec arguments expand placeholders as plain strings and do not invoke shell syntax", async () => {
  const f = await fixture(),
    marker = join(f.root, "must-not-exist");
  const hook = f.entry("plain");
  hook.args.push(
    `$(touch ${marker})`,
    "${CLAUDE_PROJECT_DIR}",
    "${CLAUDE_PLUGIN_ROOT}",
  );
  const registry = createHookRegistry([
    {
      ...f.source("PreToolUse", hook),
      pluginRoot: "/fixture/plugin with spaces",
    },
  ]);
  try {
    assert.equal(
      (await registry.run(f.input(), f.options)).results[0]?.status,
      "success",
    );
    assert.deepEqual((await f.rows())[0]?.args, [
      `$(touch ${marker})`,
      f.root,
      "/fixture/plugin with spaces",
    ]);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  } finally {
    await registry.close();
    await f.close();
  }
});

test("shell form uses only the supplied environment and explicit plugin context is required", async () => {
  const f = await fixture();
  const registry = createHookRegistry([
    f.source("PreToolUse", {
      type: "command",
      command: 'printf "%s" "$FIXTURE_VALUE"',
    }),
  ]);
  const missingPlugin = createHookRegistry([
    f.source("PreToolUse", {
      type: "command",
      command: process.execPath,
      args: ["${CLAUDE_PLUGIN_ROOT}/script.js"],
      onFailure: "block",
    }),
  ]);
  try {
    assert.equal(
      (await registry.run(f.input(), f.options)).results[0]?.stdout,
      "dummy",
    );
    assert.equal(
      (await missingPlugin.run(f.input(), f.options)).permission,
      "deny",
    );
  } finally {
    await registry.close();
    await missingPlugin.close();
    await f.close();
  }
});

test("malformed/mismatched JSON cannot grant, and registered type/condition limitations are explicit", async () => {
  const f = await fixture();
  try {
    for (const output of [
      '{"hookSpecificOutput":',
      '{"decision":"approve"}\n{"decision":"block"}',
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "Stop",
          additionalContext: "wrong",
        },
      }),
    ]) {
      const registry = createHookRegistry([
        f.source("PreToolUse", f.entry("json", output)),
      ]);
      try {
        const result = await registry.run(f.input(), f.options);
        assert.equal(result.results[0]?.status, "error");
        assert.equal(result.permission, undefined);
      } finally {
        await registry.close();
      }
    }
    assert.throws(
      () =>
        createHookRegistry([
          f.source("PreToolUse", { type: "prompt", prompt: "unsupported" }),
        ]),
      /Invalid/,
    );
    assert.throws(
      () =>
        createHookRegistry([
          f.source(
            "PreToolUse",
            f.entry("plain", undefined, { if: "Bash(git *)" }),
          ),
        ]),
      /matchesCondition/,
    );
    const registry = createHookRegistry(
      [f.source("PreToolUse", f.entry("plain", undefined, { if: "fixture" }))],
      { matchesCondition: () => false },
    );
    assert.equal((await registry.run(f.input(), f.options)).results.length, 0);
    await registry.close();
  } finally {
    await f.close();
  }
});

test("managed-only/disabled selection and invalid hook inputs cannot spawn an unintended command", async () => {
  const f = await fixture(),
    sources = [
      f.source("PreToolUse", f.entry("plain")),
      f.source("PreToolUse", f.entry("plain"), undefined, "policySettings"),
    ];
  const managed = createHookRegistry(sources, { managedOnly: true }),
    disabled = createHookRegistry(sources, { disabled: true });
  try {
    const result = await managed.run(f.input(), f.options);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.origin.source, "policySettings");
    assert.equal((await disabled.run(f.input(), f.options)).results.length, 0);
    await assert.rejects(
      managed.run(
        Object.assign(f.input(), { tool_name: undefined }),
        f.options,
      ),
      /tool hook input/i,
    );
    assert.equal((await f.rows()).length, 1);
  } finally {
    await managed.close();
    await disabled.close();
    await f.close();
  }
});

test("legacy block survives an incorrectly named specific event payload", async () => {
  const f = await fixture();
  const registry = createHookRegistry([
    f.source(
      "PreToolUse",
      f.entry("json", {
        decision: "block",
        reason: "kept block",
        hookSpecificOutput: {
          hookEventName: "Stop",
          additionalContext: "ignored wrong event",
        },
      }),
    ),
  ]);
  try {
    const result = await registry.run(f.input(), f.options);
    assert.equal(result.permission, "deny");
    assert.deepEqual(result.blockingErrors, ["kept block"]);
    assert.deepEqual(result.additionalContext, []);
  } finally {
    await registry.close();
    await f.close();
  }
});
