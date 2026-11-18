import assert from "node:assert/strict";
import { test } from "bun:test";
import { loadMcpConfigs, parseMcpConfigs } from "../../src/mcp-config.js";

const server = (config: Record<string, unknown>) => ({
  mcpServers: { s: { command: "node", ...config } },
});

test("a config without an mcpServers object is rejected", () => {
  for (const value of [null, [], "x", {}, { mcpServers: [] }])
    assert.throws(
      () => parseMcpConfigs(value, {}),
      /MCP config must contain an mcpServers object/,
    );
});

test("a server entry that is not an object is rejected by name", () => {
  assert.throws(
    () => parseMcpConfigs({ mcpServers: { bad: "node" } }, {}),
    /Invalid MCP server config: bad/,
  );
});

test("a non-string transport is reported as JSON", () => {
  assert.throws(
    () => parseMcpConfigs(server({ type: 7 }), {}),
    /Unsupported MCP transport for s: 7; supported transport: stdio/,
  );
});

test("each malformed field names the server and the field", () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ command: "" }, /MCP server s requires a command/],
    [{ args: "a" }, /MCP server s args must be strings/],
    [{ args: [1] }, /MCP server s args must be strings/],
    [{ env: { A: 1 } }, /MCP server s env must contain strings/],
    [{ timeout: "1" }, /timeout must be a positive integer/],
    [{ timeout: 1.5 }, /timeout must be a positive integer/],
    [{ timeout: 0 }, /timeout must be a positive integer/],
    [{ alwaysLoad: "yes" }, /alwaysLoad must be a boolean/],
  ];
  for (const [config, message] of cases)
    assert.throws(() => parseMcpConfigs(server(config), {}), message);
});

test("a command that expands to nothing is rejected", () => {
  assert.throws(
    () => parseMcpConfigs(server({ command: "${EMPTY}" }), { EMPTY: "" }),
    /MCP server s command resolved to an empty string/,
  );
});

test("every accepted field is kept with variables expanded", () => {
  assert.deepEqual(
    {
      ...parseMcpConfigs(
        server({
          type: "stdio",
          command: "${BIN}",
          args: ["${ARG:-fallback}"],
          env: { TOKEN: "${TOKEN}" },
          timeout: 2500,
          alwaysLoad: true,
        }),
        { BIN: "/bin/tool", TOKEN: "t" },
      ).s,
    },
    {
      type: "stdio",
      command: "/bin/tool",
      args: ["fallback"],
      env: { TOKEN: "t" },
      timeout: 2500,
      alwaysLoad: true,
    },
  );
});

test("loading without an env argument expands from the process environment", async () => {
  const name = "TAU_MCP_CONFIG_EDGE_TEST";
  process.env[name] = "from-process";
  try {
    const configs = await loadMcpConfigs(
      [JSON.stringify(server({ args: [`\${${name}}`] }))],
      "/",
    );
    assert.deepEqual(configs.s?.args, ["from-process"]);
  } finally {
    delete process.env[name];
  }
});
