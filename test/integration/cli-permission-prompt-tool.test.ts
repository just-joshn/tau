import {
  describe,
  expect,
  onTestFinished,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runCli, type CliRun } from "../helpers/cli-harness.js";
import {
  startMockProvider,
  type MockProvider,
  type ScriptedResponse,
} from "../helpers/mock-provider.js";

setDefaultTimeout(30_000);

// A stdio MCP server exposing one tool, `decide`, that answers every call with
// the decision JSON in argv[2] and appends each call's arguments to argv[3].
const GATE = String.raw`
const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});
const [decision,log]=process.argv.slice(2);
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
rl.on('close',()=>process.exit(0));
rl.on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')send(m.id,{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'gate',version:'1'}});
else if(m.method==='tools/list')send(m.id,{tools:[{name:'decide',description:'Permission gate',inputSchema:{type:'object'}}]});
else if(m.method==='tools/call'){fs.appendFileSync(log,JSON.stringify(m.params.arguments)+'\n');send(m.id,{content:[{type:'text',text:decision}]});}
else if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'unsupported'}})+'\n');
});`;

const said = (text: string): ScriptedResponse => ({
  kind: "turn",
  content: [{ type: "text", text }],
  stopReason: "end_turn",
});
const call = (
  name: string,
  input: Record<string, unknown>,
  id: string,
): ScriptedResponse => ({
  kind: "turn",
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
});

const resultSchema = z.looseObject({
  result: z.string().optional(),
  is_error: z.boolean(),
  errors: z.array(z.string()).optional(),
});
const toolResultSchema = z.looseObject({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.unknown(),
  is_error: z.boolean().optional(),
});
const bodySchema = z.looseObject({
  messages: z.array(z.looseObject({ content: z.unknown() })),
  tools: z.array(z.looseObject({ name: z.string() })).default([]),
});

/** The tool_result for `id` in a recorded request, or undefined. */
function toolResult(provider: MockProvider, request: number, id: string) {
  for (const message of bodySchema.parse(provider.requests[request]?.body)
    .messages)
    if (Array.isArray(message.content))
      for (const block of message.content) {
        const parsed = toolResultSchema.safeParse(block);
        if (parsed.success && parsed.data.tool_use_id === id)
          return parsed.data;
      }
  return undefined;
}

/** Writes the gate server and returns --mcp-config JSON plus the call log path. */
function gate(decision: Record<string, unknown>) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tau-gate-")));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, "gate.cjs");
  const log = join(dir, "calls.jsonl");
  writeFileSync(script, GATE);
  return {
    config: JSON.stringify({
      mcpServers: {
        gate: {
          command: process.execPath,
          args: [script, JSON.stringify(decision), log],
        },
      },
    }),
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) =>
              z.looseObject({ tool_name: z.string() }).parse(JSON.parse(line)),
            )
        : [],
  };
}

const BRIDGE = [
  "--permission-prompt-tool",
  "mcp__gate__decide",
  "--strict-mcp-config",
  "--output-format",
  "json",
];

function parsed(run: CliRun) {
  return resultSchema.parse(JSON.parse(run.stdout));
}

// ExitPlanMode is a deferred tool; these cases call it without a ToolSearch round.
const EAGER_PLAN_TOOLS = { ENABLE_TOOL_SEARCH: "false" };

describe("plan approval through --permission-prompt-tool", () => {
  const exitPlan = call("ExitPlanMode", { plan: "# Plan\n" }, "exit-1");

  test("an allow with permission updates approves and warns that updates are not applied", async () => {
    const provider = await startMockProvider([exitPlan, said("done")]);
    const bridge = gate({
      behavior: "allow",
      updatedInput: {},
      updatedPermissions: [
        { type: "setMode", mode: "default", destination: "session" },
      ],
    });
    const run = await runCli({
      provider,
      env: EAGER_PLAN_TOOLS,
      args: [
        "-p",
        "plan",
        "--permission-mode",
        "plan",
        ...BRIDGE,
        "--mcp-config",
        bridge.config,
      ],
    });
    expect(run.exitCode).toBe(0);
    expect(bridge.calls().map((entry) => entry.tool_name)).toEqual([
      "ExitPlanMode",
    ]);
    expect(toolResult(provider, 1, "exit-1")).toMatchObject({
      content: "Leaving plan mode was approved.",
    });
    expect(run.stderr).toContain(
      "Permissions: approval metadata updates are not yet applied by this CLI.\n",
    );
  });

  test("a bridge tool that no MCP server provides denies the approval", async () => {
    const provider = await startMockProvider([exitPlan, said("done")]);
    const run = await runCli({
      provider,
      env: EAGER_PLAN_TOOLS,
      args: ["-p", "plan", "--permission-mode", "plan", ...BRIDGE],
    });
    expect(run.exitCode).toBe(0);
    expect(toolResult(provider, 1, "exit-1")).toMatchObject({
      is_error: true,
      content: "The configured MCP permission prompt tool is not available",
    });
  });

  test("a deny that asks to interrupt ends the turn as interrupted", async () => {
    const provider = await startMockProvider([exitPlan, said("never sent")]);
    const bridge = gate({ behavior: "deny", message: "halt", interrupt: true });
    const run = await runCli({
      provider,
      env: EAGER_PLAN_TOOLS,
      args: [
        "-p",
        "plan",
        "--permission-mode",
        "plan",
        ...BRIDGE,
        "--mcp-config",
        bridge.config,
      ],
    });
    expect(run.exitCode).toBe(1);
    expect(parsed(run)).toMatchObject({
      is_error: true,
      subtype: "error_during_execution",
      errors: ["Interrupted"],
    });
    expect(provider.requests).toHaveLength(1);
  });

  test("the bridge tool is hidden from the model and refused if called", async () => {
    const provider = await startMockProvider([
      call("mcp__gate__decide", { tool_name: "Bash" }, "direct-1"),
      said("done"),
    ]);
    const bridge = gate({ behavior: "allow", updatedInput: {} });
    const run = await runCli({
      provider,
      args: ["-p", "hi", ...BRIDGE, "--mcp-config", bridge.config],
    });
    expect(run.exitCode).toBe(0);
    const offered = bodySchema
      .parse(provider.requests[0]?.body)
      .tools.map((tool) => tool.name);
    expect(offered).not.toContain("mcp__gate__decide");
    expect(toolResult(provider, 1, "direct-1")?.is_error).toBe(true);
    expect(bridge.calls()).toEqual([]);
  });
});

describe("subagent plan approval through --permission-prompt-tool", () => {
  const planner = {
    "../config/agents/planner.md":
      "---\nname: planner\ndescription: Plans work\ntools: ExitPlanMode, Read\npermissionMode: plan\n---\nPLANNER_SYSTEM",
  };
  const env = {
    CLAUDE_CODE_FORK_SUBAGENT: "0",
    CLAUDE_CODE_SUBAGENT_MODEL: "inherit",
  };
  const script = (): ScriptedResponse[] => [
    call(
      "Agent",
      {
        description: "Plan it",
        prompt: "make a plan",
        subagent_type: "planner",
        run_in_background: false,
      },
      "agent-1",
    ),
    call("ExitPlanMode", { plan: "# Child plan" }, "child-exit"),
    said("child done"),
    said("parent done"),
  ];
  const args = [
    "-p",
    "delegate",
    "--tools",
    "Agent,ExitPlanMode,Read",
    ...BRIDGE,
  ];

  test("the bridge approves the child's plan", async () => {
    const provider = await startMockProvider(script());
    const bridge = gate({ behavior: "allow", updatedInput: {} });
    const run = await runCli({
      provider,
      env,
      files: planner,
      args: [...args, "--mcp-config", bridge.config],
    });
    expect(run.exitCode).toBe(0);
    expect(parsed(run).result).toBe("parent done");
    expect(bridge.calls().map((entry) => entry.tool_name)).toEqual([
      "ExitPlanMode",
    ]);
    expect(toolResult(provider, 2, "child-exit")).toMatchObject({
      content: "Plan approval completed for this agent.",
    });
  });

  test("an unavailable bridge denies the child's plan", async () => {
    const provider = await startMockProvider(script());
    const run = await runCli({ provider, env, files: planner, args });
    expect(run.exitCode).toBe(0);
    expect(toolResult(provider, 2, "child-exit")).toMatchObject({
      is_error: true,
      content: "The configured MCP permission prompt tool is unavailable",
    });
  });

  test("an interrupting deny ends the parent turn", async () => {
    const provider = await startMockProvider(script());
    const bridge = gate({ behavior: "deny", message: "halt", interrupt: true });
    const run = await runCli({
      provider,
      env,
      files: planner,
      args: [...args, "--mcp-config", bridge.config],
    });
    expect(run.exitCode).toBe(1);
    expect(parsed(run)).toMatchObject({
      is_error: true,
      subtype: "error_during_execution",
      errors: ["Interrupted"],
    });
    expect(provider.requests).toHaveLength(2);
  });
});
