import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { onTestFinished, test } from "bun:test";
import { z } from "zod";
import {
  McpManager,
  McpProtocolError,
  type McpStdioConfig,
} from "../../src/mcp.js";

const MODERN = "2026-07-28";
const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";
const FRAME_LIMIT = 16 * 1024 * 1024;

// A scriptable stdio MCP server. SCENARIO maps a method to one reply step, or
// to a list of steps used in call order (the last one repeats). A step may
// write raw lines before replying ("$ID" and "$TOKEN" are filled from the
// request), stay silent, delay, exit, or flood stdout without a newline.
// Every message the server receives is appended to LOG.
const server = String.raw`
const fs = require("node:fs");
const scenario = JSON.parse(process.env.SCENARIO || "{}");
const log = process.env.LOG;
if (log) fs.writeFileSync(log + ".pid", String(process.pid));
if (scenario.ignoreTerm) process.on("SIGTERM", () => {});
const keepAlive = scenario.ignoreStdinEnd ? setInterval(() => {}, 1000) : undefined;
const write = (value) => process.stdout.write((typeof value === "string" ? value : JSON.stringify(value)) + "\n");
const fill = (line, m) => line
  .replaceAll('"$ID"', JSON.stringify(m.id ?? null))
  .replaceAll('"$TOKEN"', JSON.stringify(m.params?._meta?.progressToken ?? null));
const defaults = {
  initialize: { result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "edge", version: "1" } } },
  "tools/list": { result: { tools: [] } },
};
const counts = {};
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let i; (i = buffer.indexOf("\n")) >= 0; ) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    void handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => {
  for (const line of scenario.onEnd ?? []) write(line);
  if (!keepAlive) setTimeout(() => process.exit(0), 20);
});
async function handle(m) {
  if (log) fs.appendFileSync(log, JSON.stringify(m) + "\n");
  if (typeof m.method !== "string") return;
  const n = (counts[m.method] = (counts[m.method] ?? 0) + 1) - 1;
  const entry = scenario[m.method] ?? defaults[m.method];
  if (entry === undefined) {
    if (m.id !== undefined) write({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
    return;
  }
  const step = Array.isArray(entry) ? entry[Math.min(n, entry.length - 1)] : entry;
  for (const line of step.before ?? []) write(fill(line, m));
  if (step.flood) process.stdout.write("x".repeat(step.flood));
  if (step.delay) await new Promise((resolve) => setTimeout(resolve, step.delay));
  if (step.exit !== undefined) process.exit(step.exit);
  if (step.silent || m.id === undefined) return;
  if (step.raw) {
    for (const line of step.raw) write(fill(line, m));
    return;
  }
  write({ jsonrpc: "2.0", id: m.id, ...(step.error ? { error: step.error } : { result: step.result }) });
}
`;

interface Step {
  result?: unknown;
  error?: unknown;
  raw?: string[];
  before?: string[];
  silent?: boolean;
  delay?: number;
  exit?: number;
  flood?: number;
}
interface ServerSpec {
  steps?: Record<string, Step | Step[]>;
  ignoreTerm?: boolean;
  ignoreStdinEnd?: boolean;
  onEnd?: string[];
  config?: Partial<McpStdioConfig>;
}

const line = (value: unknown) => JSON.stringify(value);
const rpc = (value: Record<string, unknown>) =>
  line({ jsonrpc: "2.0", ...value });
const tool = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  inputSchema: { type: "object" },
  ...extra,
});
const modernDiscover: Step = {
  result: {
    supportedVersions: [MODERN],
    capabilities: { tools: { listChanged: true } },
  },
};
const ack = rpc({
  method: "notifications/subscriptions/acknowledged",
  params: { _meta: { [SUBSCRIPTION_ID]: "listen:0" }, notifications: {} },
});
const complete = (result: Record<string, unknown>) => ({
  resultType: "complete",
  ...result,
});
const text = (value: string) => ({ content: [{ type: "text", text: value }] });

const logRow = z.looseObject({
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
type LogRow = z.infer<typeof logRow>;

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "tau-mcp-edges-"));
  const script = join(directory, "server.cjs");
  await writeFile(script, `#!${process.execPath}\n${server}`);
  await chmod(script, 0o755);
  const warnings: string[] = [];
  const managers: McpManager[] = [];
  onTestFinished(async () => {
    await Promise.all(managers.map((manager) => manager.close()));
    await rm(directory, { recursive: true, force: true });
  });
  const logPath = (name: string) => join(directory, `${name}.jsonl`);
  const config = (name: string, spec: ServerSpec = {}): McpStdioConfig => ({
    // No args: the script runs through its shebang.
    command: script,
    env: {
      SCENARIO: JSON.stringify({
        ...spec.steps,
        ...(spec.ignoreTerm ? { ignoreTerm: true } : {}),
        ...(spec.ignoreStdinEnd ? { ignoreStdinEnd: true } : {}),
        ...(spec.onEnd ? { onEnd: spec.onEnd } : {}),
      }),
      LOG: logPath(name),
    },
    ...spec.config,
  });
  const connect = async (
    servers: Record<string, ServerSpec>,
    options: Partial<Parameters<typeof McpManager.connect>[1]> = {},
  ) => {
    const manager = await McpManager.connect(
      Object.fromEntries(
        Object.entries(servers).map(([name, spec]) => [
          name,
          config(name, spec),
        ]),
      ),
      {
        cwd: directory,
        env: { PATH: process.env.PATH ?? "" },
        onWarning: (message) => warnings.push(message),
        ...options,
      },
    );
    managers.push(manager);
    return manager;
  };
  const alive = async (name: string): Promise<boolean> => {
    const pid = Number(await readFile(`${logPath(name)}.pid`, "utf8"));
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const received = async (name: string): Promise<LogRow[]> => {
    const content = await readFile(logPath(name), "utf8").catch(() => "");
    return content
      .split("\n")
      .filter(Boolean)
      .map((row) => logRow.parse(JSON.parse(row)));
  };
  const waitFor = async (
    name: string,
    found: (rows: LogRow[]) => boolean,
  ): Promise<LogRow[]> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const rows = await received(name);
      if (found(rows)) return rows;
      if (Date.now() > deadline)
        throw new Error(`server ${name} never received the expected messages`);
      await Bun.sleep(10);
    }
  };
  return { directory, warnings, connect, received, waitFor, alive };
}

const call = (manager: McpManager, name: string, input: unknown = {}) =>
  manager.callTool(name, input, new AbortController().signal);

test("a server whose tool listing breaks the MCP schema stays offline with a reason", async () => {
  const h = await harness();
  const listing = (tools: unknown[]): ServerSpec => ({
    steps: { "tools/list": { result: { tools } } },
  });
  const bad: Record<string, [ServerSpec, string]> = {
    shape: [
      listing([tool("t", { inputSchema: { type: "array" } })]),
      "Invalid MCP tool definition",
    ],
    description: [
      listing([tool("t", { description: 5 })]),
      "Invalid MCP tool description",
    ],
    properties: [
      listing([tool("t", { inputSchema: { type: "object", properties: [] } })]),
      "Invalid MCP input schema properties",
    ],
    required: [
      listing([tool("t", { inputSchema: { type: "object", required: "a" } })]),
      "Invalid MCP input schema required list",
    ],
    requiredItems: [
      listing([tool("t", { inputSchema: { type: "object", required: [1] } })]),
      "Invalid MCP input schema required list",
    ],
    annotations: [
      listing([tool("t", { annotations: [] })]),
      "Invalid MCP tool annotations",
    ],
    hint: [
      listing([tool("t", { annotations: { readOnlyHint: "yes" } })]),
      "Invalid MCP tool annotation: readOnlyHint",
    ],
    title: [
      listing([tool("t", { annotations: { title: 1 } })]),
      "Invalid MCP tool title",
    ],
    meta: [listing([tool("t", { _meta: [] })]), "Invalid MCP tool metadata"],
    output: [
      listing([tool("t", { outputSchema: [] })]),
      "Invalid MCP tool output schema",
    ],
    list: [
      { steps: { "tools/list": { result: { tools: "t" } } } },
      "Invalid MCP tools/list result",
    ],
    cursor: [
      { steps: { "tools/list": { result: { tools: [], nextCursor: 5 } } } },
      "Invalid MCP pagination cursor",
    ],
    initialize: [
      {
        steps: {
          initialize: {
            result: {
              protocolVersion: "1999-01-01",
              capabilities: {},
              serverInfo: { name: "x", version: "1" },
            },
          },
        },
      },
      "MCP server returned an invalid or unsupported initialize result",
    ],
  };
  const manager = await h.connect({
    ...Object.fromEntries(
      Object.entries(bad).map(([name, [spec]]) => [name, spec]),
    ),
    good: listing([tool("ok")]),
  });
  assert.deepEqual(
    manager.definitions.map((definition) => definition.name),
    ["mcp__good__ok"],
  );
  assert.deepEqual(
    h.warnings,
    Object.entries(bad).map(
      ([name, [, reason]]) => `MCP server ${name} failed to connect: ${reason}`,
    ),
  );
});

test("a server without a tools capability is connected but never asked for tools", async () => {
  const h = await harness();
  const manager = await h.connect({
    bare: {
      steps: {
        initialize: {
          result: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            serverInfo: { name: "bare", version: "1" },
          },
        },
      },
    },
  });
  assert.deepEqual(manager.definitions, []);
  assert.deepEqual(h.warnings, []);
  const rows = await h.waitFor("bare", (rows) =>
    rows.some((row) => row.method === "notifications/initialized"),
  );
  const methods = rows.map((row) => row.method);
  assert.deepEqual(methods, [
    "server/discover",
    "initialize",
    "notifications/initialized",
  ]);
});

test("tool metadata reflects annotations, output schemas and the per-tool alwaysLoad opt-out", async () => {
  const h = await harness();
  const long = "t".repeat(130);
  const manager = await h.connect({
    meta: {
      config: { alwaysLoad: true },
      steps: {
        "tools/list": {
          result: {
            tools: [
              tool("plain"),
              tool("optOut", { _meta: { "anthropic/alwaysLoad": false } }),
              tool("rich", {
                description: "Rich",
                annotations: {
                  title: "Rich",
                  destructiveHint: true,
                  openWorldHint: true,
                },
                outputSchema: { type: "object" },
              }),
              tool(long),
            ],
          },
        },
      },
    },
  });
  assert.deepEqual(
    manager.definitions.map((definition) => definition.name),
    ["mcp__meta__plain", "mcp__meta__optOut", "mcp__meta__rich"],
  );
  assert.equal(manager.lookup("mcp__meta__plain")?.alwaysLoad, true);
  assert.equal(manager.lookup("mcp__meta__optOut")?.alwaysLoad, false);
  assert.deepEqual(manager.lookup("mcp__meta__rich"), {
    serverName: "meta",
    toolName: "rich",
    isReadOnly: false,
    destructiveHint: true,
    openWorldHint: true,
    requiresUserInteraction: false,
    alwaysLoad: true,
    annotations: { title: "Rich", destructiveHint: true, openWorldHint: true },
    outputSchema: { type: "object" },
  });
  assert.deepEqual(h.warnings, [
    `MCP tool name exceeds the API's 128-character limit: mcp__meta__${long}`,
  ]);
});

test("legacy servers get answers to ping, roots and unknown requests; junk lines are skipped", async () => {
  const h = await harness();
  const manager = await h.connect({
    chatty: {
      steps: {
        "notifications/initialized": {
          before: [
            rpc({ id: "p", method: "ping" }),
            rpc({ id: "r", method: "roots/list" }),
            rpc({ id: "s", method: "sampling/createMessage", params: {} }),
            "{not json",
            line({ jsonrpc: "1.0", id: 1, result: {} }),
            rpc({ id: null, result: {} }),
            rpc({ id: 999, result: {} }),
            rpc({
              method: "notifications/progress",
              params: { progressToken: {} },
            }),
            rpc({
              method: "notifications/cancelled",
              params: { requestId: {} },
            }),
            rpc({
              method: "notifications/cancelled",
              params: { requestId: 999 },
            }),
            rpc({ method: "notifications/message", params: { level: "info" } }),
          ],
        },
        "tools/list": { result: { tools: [tool("t")] } },
      },
    },
  });
  const rows = await h.waitFor("chatty", (rows) =>
    ["p", "r", "s"].every((id) =>
      rows.some((row) => row.id === id && !row.method),
    ),
  );
  const reply = (id: string) => {
    const row = rows.find(
      (candidate) => candidate.id === id && !candidate.method,
    );
    return row && { result: row.result, error: row.error };
  };
  assert.deepEqual(reply("p"), { result: {}, error: undefined });
  assert.deepEqual(reply("r"), {
    result: { roots: [{ uri: pathToFileURL(h.directory).href }] },
    error: undefined,
  });
  assert.deepEqual(reply("s"), {
    result: undefined,
    error: {
      code: -32601,
      message: "Method not found: sampling/createMessage",
    },
  });
  assert.deepEqual(h.warnings, [
    "MCP server chatty: ignoring malformed JSON-RPC line",
    "MCP server chatty: ignoring invalid JSON-RPC message",
  ]);
  assert.deepEqual(
    manager.definitions.map((definition) => definition.name),
    ["mcp__chatty__t"],
  );
});

test("a malformed or mismatched discovery reply falls back to the legacy handshake", async () => {
  const h = await harness();
  const manager = await h.connect({
    invalid: {
      steps: {
        "server/discover": {
          raw: [line({ jsonrpc: "1.0", id: "$ID", result: {} })],
        },
        "tools/list": { result: { tools: [tool("a")] } },
      },
    },
    mismatch: {
      steps: {
        "server/discover": { raw: [rpc({ id: 4242, result: {} })] },
        "tools/list": { result: { tools: [tool("b")] } },
      },
    },
    old: {
      steps: {
        "server/discover": {
          result: { supportedVersions: ["2025-06-18"], capabilities: {} },
        },
        "tools/list": { result: { tools: [tool("c")] } },
      },
    },
  });
  assert.deepEqual(
    manager.definitions.map((definition) => definition.name),
    ["mcp__invalid__a", "mcp__mismatch__b", "mcp__old__c"],
  );
  for (const name of ["invalid", "mismatch", "old"])
    assert.ok(
      (await h.received(name)).some((row) => row.method === "initialize"),
      name,
    );
  assert.deepEqual(h.warnings, []);
});

test("legacy negotiation from the environment skips discovery", async () => {
  const h = await harness();
  await h.connect(
    { legacy: {} },
    {
      env: { PATH: process.env.PATH ?? "", MCP_PROTOCOL_NEGOTIATION: "legacy" },
    },
  );
  assert.equal((await h.received("legacy"))[0]?.method, "initialize");
});

test("a server that exits during discovery is not silently replaced", async () => {
  const h = await harness();
  const manager = await h.connect({
    gone: { steps: { "server/discover": { exit: 3 } } },
  });
  assert.deepEqual(manager.definitions, []);
  assert.deepEqual(h.warnings, [
    "MCP server gone failed to connect: MCP server gone closed the connection",
  ]);
  assert.ok(
    !(await h.received("gone")).some((row) => row.method === "initialize"),
  );
});

test("connecting with an already-aborted signal rejects before starting any server", async () => {
  const h = await harness();
  const controller = new AbortController();
  controller.abort("not an error");
  await assert.rejects(
    h.connect({ never: {} }, { signal: controller.signal }),
    (error: unknown) =>
      error instanceof DOMException && error.name === "AbortError",
  );
  assert.deepEqual(await h.received("never"), []);
});

test("aborting while discovery or the subscription is pending rejects the connect", async () => {
  for (const method of ["server/discover", "subscriptions/listen"]) {
    const h = await harness();
    const controller = new AbortController();
    const reason = new Error(`stop at ${method}`);
    const connecting = h.connect(
      {
        slow: {
          steps: {
            "server/discover":
              method === "server/discover" ? { silent: true } : modernDiscover,
            "subscriptions/listen": { silent: true },
          },
        },
      },
      { signal: controller.signal },
    );
    await h.waitFor("slow", (rows) =>
      rows.some((row) => row.method === method),
    );
    controller.abort(reason);
    await assert.rejects(connecting, (error: unknown) => error === reason);
    assert.deepEqual(h.warnings, []);
  }
});

test("modern servers: requests are not answered, and unknown acknowledgments are ignored", async () => {
  const h = await harness();
  const manager = await h.connect({
    modern: {
      steps: {
        "server/discover": modernDiscover,
        "subscriptions/listen": {
          before: [
            rpc({ id: "q", method: "ping" }),
            rpc({
              method: "notifications/subscriptions/acknowledged",
              params: { _meta: 5 },
            }),
            rpc({
              method: "notifications/subscriptions/acknowledged",
              params: { _meta: { [SUBSCRIPTION_ID]: "other" } },
            }),
            ack,
          ],
          silent: true,
        },
        "tools/list": { result: complete({ tools: [tool("t")] }) },
        "tools/call": [
          { result: 5 },
          { result: text("no type") },
          { result: { resultType: 7 } },
          { result: { resultType: "streaming" } },
          { result: complete(text("done")) },
        ],
      },
    },
  });
  const expected: (string | RegExp)[] = [
    "Invalid modern MCP tools/call result: not an object",
    "Invalid modern MCP tools/call result: missing required resultType",
    "MCP resultType 7 is not supported by this port; the call will not be replayed",
    "MCP resultType streaming is not supported by this port; the call will not be replayed",
  ];
  for (const message of expected)
    await assert.rejects(call(manager, "mcp__modern__t"), (error: unknown) => {
      assert.ok(error instanceof McpProtocolError);
      assert.equal(error.code, -32600);
      assert.equal(error.message, message);
      return true;
    });
  assert.equal((await call(manager, "mcp__modern__t")).projection.text, "done");
  const rows = await h.received("modern");
  assert.ok(!rows.some((row) => row.id === "q" && !row.method));
  assert.deepEqual(h.warnings, []);
});

test("a subscription closed before acknowledgment is reported and the server still lists tools", async () => {
  const h = await harness();
  const manager = await h.connect({
    early: {
      steps: {
        "server/discover": modernDiscover,
        "subscriptions/listen": {
          raw: [rpc({ id: "listen:0", result: complete({}) })],
        },
        "tools/list": { result: complete({ tools: [tool("t")] }) },
      },
    },
  });
  assert.deepEqual(h.warnings, [
    "MCP server early list-change subscription failed: MCP subscription closed before acknowledgment",
  ]);
  assert.deepEqual(
    manager.definitions.map((definition) => definition.name),
    ["mcp__early__t"],
  );
});

test("a server that ends an acknowledged subscription is not asked to cancel it on close", async () => {
  const h = await harness();
  const manager = await h.connect({
    ended: {
      steps: {
        "server/discover": modernDiscover,
        "subscriptions/listen": { before: [ack], silent: true },
        "tools/list": { result: complete({ tools: [tool("t")] }) },
        "tools/call": {
          before: [rpc({ id: "listen:0", result: complete({}) })],
          result: complete(text("ok")),
        },
      },
    },
  });
  assert.equal((await call(manager, "mcp__ended__t")).projection.text, "ok");
  await manager.close();
  const cancels = (await h.received("ended")).filter(
    (row) => row.method === "notifications/cancelled",
  );
  assert.deepEqual(cancels, []);
});

test("a server that exits while subscribing reports both failures", async () => {
  const h = await harness();
  const manager = await h.connect({
    quits: {
      steps: {
        "server/discover": modernDiscover,
        "subscriptions/listen": { exit: 0 },
      },
    },
  });
  assert.deepEqual(manager.definitions, []);
  assert.deepEqual(h.warnings, [
    "MCP server quits list-change subscription failed: MCP server quits closed the connection",
    "MCP server quits failed to connect: MCP server quits is disconnected",
  ]);
});

test("server-side cancellation and malformed responses reject the call with protocol errors", async () => {
  const h = await harness();
  const manager = await h.connect({
    cancels: {
      steps: {
        "tools/list": { result: { tools: [tool("t")] } },
        "tools/call": [
          {
            before: [
              rpc({
                method: "notifications/cancelled",
                params: { requestId: "$TOKEN", reason: "busy" },
              }),
            ],
            silent: true,
          },
          {
            before: [
              rpc({
                method: "notifications/cancelled",
                params: { requestId: "$TOKEN" },
              }),
            ],
            silent: true,
          },
          { raw: [rpc({ id: "$ID" })] },
          { result: { resultType: "task" } },
        ],
      },
    },
  });
  const failures: [number, string][] = [
    [-32800, "busy"],
    [-32800, "Server cancelled request"],
    [-32600, "Invalid JSON-RPC response"],
  ];
  for (const [code, message] of failures)
    await assert.rejects(call(manager, "mcp__cancels__t"), (error: unknown) => {
      assert.ok(error instanceof McpProtocolError);
      assert.deepEqual([error.code, error.message], [code, message]);
      return true;
    });
  // Legacy results carry no resultType envelope, so a task result is refused here.
  await assert.rejects(
    call(manager, "mcp__cancels__t"),
    /^Error: MCP task results are not supported by this port; the call will not be replayed$/,
  );
});

test("calls are validated before anything is sent to the server", async () => {
  const h = await harness();
  const manager = await h.connect({
    v: { steps: { "tools/list": { result: { tools: [tool("t")] } } } },
  });
  await assert.rejects(
    call(manager, "mcp__v__missing"),
    /Unknown MCP tool: mcp__v__missing/,
  );
  await assert.rejects(
    call(manager, "mcp__v__t", []),
    /MCP tool arguments must be an object/,
  );
  await assert.rejects(
    call(manager, "mcp__v__t", { blob: "x".repeat(FRAME_LIMIT) }),
    /MCP request exceeds the 16 MiB stdio frame limit/,
  );
  assert.ok(
    !(await h.received("v")).some((row) => row.method === "tools/call"),
  );
});

test("an inline PDF budget returns a PDF result as a document block", async () => {
  const h = await harness();
  const pdf = Buffer.from("%PDF-1.4 tiny").toString("base64");
  const manager = await h.connect(
    {
      pdf: {
        steps: {
          "tools/list": { result: { tools: [tool("t")] } },
          "tools/call": {
            result: {
              content: [
                {
                  type: "resource",
                  resource: {
                    uri: "file:///a.pdf",
                    mimeType: "application/pdf",
                    blob: pdf,
                  },
                },
              ],
            },
          },
        },
      },
    },
    { inlinePdfBytes: 1024 },
  );
  const { projection } = await call(manager, "mcp__pdf__t");
  assert.deepEqual(projection.blocks, [
    {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: pdf },
    },
  ]);
});

test("a non-positive idle timeout disables the idle deadline", async () => {
  const h = await harness();
  const manager = await h.connect(
    {
      slow: {
        steps: {
          "tools/list": { result: { tools: [tool("t")] } },
          "tools/call": { delay: 400, result: text("late") },
        },
      },
    },
    {
      env: {
        PATH: process.env.PATH ?? "",
        CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "0",
      },
    },
  );
  assert.equal((await call(manager, "mcp__slow__t")).projection.text, "late");
});

test("a reply larger than the stdio frame limit fails the call and force-kills the server", async () => {
  const h = await harness();
  const manager = await h.connect({
    flood: {
      // Survives end of input and SIGTERM, so only SIGKILL can stop it.
      ignoreTerm: true,
      ignoreStdinEnd: true,
      steps: {
        "tools/list": { result: { tools: [tool("t")] } },
        "tools/call": { flood: FRAME_LIMIT + 1, silent: true },
      },
    },
  });
  await assert.rejects(
    call(manager, "mcp__flood__t"),
    /^Error: MCP server flood exceeded the 16 MiB stdio frame limit$/,
  );
  await assert.rejects(
    call(manager, "mcp__flood__t"),
    /MCP server flood is disconnected/,
  );
  const deadline = Date.now() + 5000;
  while ((await h.alive("flood")) && Date.now() < deadline) await Bun.sleep(20);
  assert.equal(await h.alive("flood"), false);
});

test("close terminates a server that ignores end of input", async () => {
  const h = await harness();
  const manager = await h.connect({ stubborn: { ignoreStdinEnd: true } });
  await manager.close();
  assert.equal(await h.alive("stubborn"), false);
  assert.deepEqual(h.warnings, []);
});

test("list changes refresh tools; failed refreshes warn until the manager closes", async () => {
  const h = await harness();
  const changed = rpc({ method: "notifications/tools/list_changed" });
  const manager = await h.connect({
    live: {
      onEnd: [changed],
      steps: {
        "tools/list": [
          { result: { tools: [tool("a")] } },
          { result: { tools: [tool("a"), tool("b")] } },
          { result: { tools: "broken" } },
          { silent: true },
        ],
        "tools/call": { before: [changed], result: text("ok") },
      },
    },
  });
  await call(manager, "mcp__live__a");
  await h.waitFor(
    "live",
    (rows) => rows.filter((row) => row.method === "tools/list").length >= 2,
  );
  await manager.refreshTools();
  assert.deepEqual(
    manager.definitions.map((definition) => definition.name),
    ["mcp__live__a", "mcp__live__b"],
  );

  await call(manager, "mcp__live__a");
  await h.waitFor(
    "live",
    (rows) => rows.filter((row) => row.method === "tools/list").length >= 3,
  );
  await manager.refreshTools().catch(() => {});
  assert.deepEqual(h.warnings, [
    "MCP server live tool refresh failed: Invalid MCP tools/list result",
  ]);

  // The fourth listing never answers; closing must not report it as a failure,
  // and a list change sent while closing starts no new listing.
  await call(manager, "mcp__live__a");
  await h.waitFor(
    "live",
    (rows) => rows.filter((row) => row.method === "tools/list").length >= 4,
  );
  await manager.close();
  assert.equal(h.warnings.length, 1);
  assert.equal(
    (await h.received("live")).filter((row) => row.method === "tools/list")
      .length,
    4,
  );
});
