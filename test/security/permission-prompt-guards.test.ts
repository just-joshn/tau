import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  createMcpPermissionPrompt,
  parsePermissionPromptUpdates,
  permissionPromptAllowedInput,
} from "../../src/permission-prompt.js";
import type { ExternalToolRegistry } from "../../src/tool-router.js";
import type { ToolUse } from "../../src/types.js";

const promptTool = "mcp__gate__permit";
const call = (overrides: Partial<ToolUse> = {}): ToolUse => ({
  type: "tool_use",
  id: "call-1",
  name: "Write",
  input: { file_path: "/repo/a.txt", content: "a" },
  ...overrides,
});
const reply = (decision: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(decision) }],
});
const allow = reply({ behavior: "allow" });

/** A prompt server plus the MCP targets it may be asked about. */
function gate(
  options: {
    raw?: unknown;
    projectionError?: boolean;
    lookupThrows?: boolean;
    fail?: unknown;
    targets?: Record<string, { requiresUserInteraction: boolean }>;
  } = {},
) {
  const state = { available: true };
  const sent: unknown[] = [];
  const registry: ExternalToolRegistry = {
    definitions: [],
    lookup(name) {
      if (options.lookupThrows) throw new Error("registry offline");
      if (name === promptTool)
        return state.available
          ? {
              serverName: "gate",
              isReadOnly: false,
              requiresUserInteraction: false,
            }
          : undefined;
      const target = options.targets?.[name];
      return target && { serverName: "target", isReadOnly: false, ...target };
    },
    async callTool(_name, input) {
      sent.push(input);
      if (options.fail !== undefined) throw options.fail;
      return {
        raw: options.raw ?? allow,
        projection: {
          text: "",
          ...(options.projectionError ? { isError: true } : {}),
        },
      };
    },
  };
  return { registry, sent, state };
}
const ask = (
  prompt: ReturnType<typeof createMcpPermissionPrompt>,
  request: ToolUse = call(),
) => prompt.request(request, new AbortController().signal);

// A host written in JavaScript can return an array where a record is typed.
class ArrayRecord extends Array<unknown> {
  [key: string]: unknown;
}

test("INV-01 a request without object input, tool name and id is denied before the prompt server sees it", async () => {
  const { registry, sent } = gate();
  const prompt = createMcpPermissionPrompt({ toolName: promptTool, registry });
  for (const request of [
    call({ input: "write everything" }),
    call({ input: ["a"] }),
    call({ input: null }),
    call({ name: "" }),
    call({ id: "" }),
  ])
    assert.deepEqual(await ask(prompt, request), {
      approved: false,
      reason:
        "The permission request requires a tool name, id and object input",
    });
  assert.deepEqual(sent, []);
});

test("INV-01 a prompt tool the registry cannot look up is never ready and never called", async () => {
  const { registry, sent } = gate({ lookupThrows: true });
  const prompt = createMcpPermissionPrompt({ toolName: promptTool, registry });
  assert.equal(prompt.ready, false);
  assert.deepEqual(await ask(prompt), {
    approved: false,
    reason: "The configured MCP permission prompt tool is not available",
  });
  assert.deepEqual(sent, []);
});

test("INV-01 a host admission refusal or a prompt tool lost during admission denies", async () => {
  const refused = gate();
  assert.deepEqual(
    await ask(
      createMcpPermissionPrompt({
        toolName: promptTool,
        registry: refused.registry,
        admitRequest: () => false,
      }),
    ),
    {
      approved: false,
      reason:
        "This permission request is not eligible for the configured MCP prompt tool",
    },
  );
  const lost = gate();
  const prompt = createMcpPermissionPrompt({
    toolName: promptTool,
    registry: lost.registry,
    admitRequest: () => {
      lost.state.available = false;
      return true;
    },
  });
  assert.deepEqual(await ask(prompt), {
    approved: false,
    reason: "The configured MCP permission prompt tool is no longer available",
  });
  assert.deepEqual([...refused.sent, ...lost.sent], []);
});

test("INV-01 an error projection or a non-text first block cannot grant", async () => {
  const projected = gate({ projectionError: true });
  assert.deepEqual(
    await ask(
      createMcpPermissionPrompt({
        toolName: promptTool,
        registry: projected.registry,
      }),
    ),
    {
      approved: false,
      reason: "The MCP permission prompt tool returned an error",
    },
  );
  const smuggled = gate({
    raw: {
      content: [
        {
          type: "image",
          data: "",
          mimeType: "image/png",
          text: JSON.stringify({ behavior: "allow" }),
        },
      ],
    },
  });
  assert.deepEqual(
    await ask(
      createMcpPermissionPrompt({
        toolName: promptTool,
        registry: smuggled.registry,
      }),
    ),
    {
      approved: false,
      reason:
        "The permission prompt tool must return JSON in its first text content block",
    },
  );
});

test("INV-01 the prompt can approve an MCP target that does not require user interaction", async () => {
  const target = "mcp__target__write";
  const { registry } = gate({
    targets: { [target]: { requiresUserInteraction: false } },
  });
  const prompt = createMcpPermissionPrompt({ toolName: promptTool, registry });
  assert.deepEqual(
    await ask(prompt, call({ name: target, input: { path: "a" } })),
    {
      approved: true,
      updatedInput: { path: "a" },
    },
  );
});

test("INV-01 an approval whose normalized input is not an object is denied", async () => {
  const { registry } = gate();
  const prompt = createMcpPermissionPrompt({
    toolName: promptTool,
    registry,
    normalizeAllowedInput: () => new ArrayRecord(),
  });
  assert.deepEqual(await ask(prompt), {
    approved: false,
    reason: "The permission input normalizer returned invalid input",
  });
});

test("INV-01 a failed prompt call denies and reports the failure", async () => {
  for (const [fail, detail] of [
    [new Error("socket closed"), "socket closed"],
    ["not an error", "request failed"],
  ] as const) {
    const diagnostics: string[] = [];
    const { registry } = gate({ fail });
    const prompt = createMcpPermissionPrompt({
      toolName: promptTool,
      registry,
      onDiagnostic: (message) => diagnostics.push(message),
    });
    assert.deepEqual(await ask(prompt), {
      approved: false,
      reason: "The MCP permission prompt request failed",
    });
    assert.deepEqual(diagnostics, [`MCP permission prompt failed: ${detail}`]);
  }
});

test("INV-01 directory updates count toward the update budget", () => {
  for (const type of ["addDirectories", "removeDirectories"]) {
    const diagnostics: string[] = [];
    const updates = [
      {
        type,
        directories: Array.from({ length: 4097 }, (_, index) => `/d${index}`),
        destination: "session",
      },
    ];
    assert.equal(
      parsePermissionPromptUpdates(updates, (message) =>
        diagnostics.push(message),
      ),
      undefined,
      type,
    );
    assert.deepEqual(diagnostics, [
      "Permission prompt updatedPermissions exceeds 4096 updates, rules and directories; updates were ignored",
    ]);
  }
});

test("INV-01 a file-backed ExitPlanMode approval drops a model-supplied plan", () => {
  assert.deepEqual(
    permissionPromptAllowedInput(
      call({
        name: "ExitPlanMode",
        input: { plan: "model text", allowedPrompts: [] },
      }),
    ),
    { allowedPrompts: [] },
  );
});
