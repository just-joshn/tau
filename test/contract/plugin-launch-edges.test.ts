import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import { loadLaunchConfiguration } from "../../src/launch-configuration.js";
import { parseOptions } from "../../src/options.js";
import { loadLaunchPlugins } from "../../src/plugin-launch.js";
import { SETTINGS_MAX_BYTES } from "../../src/configuration.js";

const stopHook = { Stop: [{ hooks: [{ type: "command", command: "true" }] }] };

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-plugin-launch-")),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project"),
    user = join(root, "config"),
    managed = join(root, "managed");
  for (const path of [cwd, user, managed]) await mkdir(path);
  const env = { CLAUDE_CONFIG_DIR: user, TAU_MANAGED_ROOT: managed };
  const plugin = async (
    name: string,
    files: Record<string, string | object>,
  ) => {
    const dir = join(root, name);
    for (const [path, content] of Object.entries(files)) {
      const file = join(dir, path);
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(
        file,
        typeof content === "string" ? content : JSON.stringify(content),
      );
    }
    await mkdir(dir, { recursive: true });
    return dir;
  };
  const load = async (directories: string[], signal?: AbortSignal) => {
    const launch = await loadLaunchConfiguration(parseOptions([]), {
      cwd,
      env,
      homeDirectory: root,
      nonInteractive: true,
    });
    const diagnostics: string[] = [];
    const result = await loadLaunchPlugins({
      cwd,
      directories,
      launch,
      env,
      ...(signal ? { signal } : {}),
      onDiagnostic: (message) => diagnostics.push(message),
    });
    return { ...result, diagnostics };
  };
  return { root, plugin, load };
}

test("a manifest without a string name withholds the directory", async () => {
  const f = await fixture();
  const array = await f.plugin("array", { ".claude-plugin/plugin.json": [] });
  const unnamed = await f.plugin("unnamed", {
    ".claude-plugin/plugin.json": { version: "1" },
  });
  const loaded = await f.load([array, unnamed]);
  assert.deepEqual(loaded.plugins, []);
  assert.deepEqual(loaded.diagnostics, [
    `Plugin ${array} withheld: Plugin manifest requires a name`,
    `Plugin ${unnamed} withheld: Plugin manifest requires a name`,
  ]);
});

test("an oversized manifest withholds the directory with the read reason", async () => {
  const f = await fixture();
  const big = await f.plugin("big", {
    ".claude-plugin/plugin.json": JSON.stringify({
      name: "big",
      pad: "x".repeat(SETTINGS_MAX_BYTES),
    }),
  });
  const loaded = await f.load([big]);
  assert.deepEqual(loaded.plugins, []);
  assert.deepEqual(loaded.diagnostics, [
    `Plugin ${big} withheld: Configuration input exceeds ${SETTINGS_MAX_BYTES} bytes`,
  ]);
});

test("a directory without a manifest is named after the directory", async () => {
  const f = await fixture();
  const bare = await f.plugin("bare-plugin", {});
  const loaded = await f.load([bare]);
  assert.deepEqual(
    loaded.plugins.map((plugin) => [plugin.name, plugin.source]),
    [["bare-plugin", "bare-plugin@inline"]],
  );
});

test("hook events this host cannot run reject the hook file, and keep the plugin", async () => {
  const f = await fixture();
  const dir = await f.plugin("hooky", {
    ".claude-plugin/plugin.json": { name: "hooky" },
    "hooks/hooks.json": {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "true" }] }],
      },
    },
  });
  const loaded = await f.load([dir]);
  assert.deepEqual(
    loaded.plugins.map((plugin) => plugin.name),
    ["hooky"],
  );
  assert.deepEqual(loaded.hookSources, []);
  assert.deepEqual(loaded.diagnostics, [
    "hooky@inline: Error: Plugin declares hook events unsupported by this command host",
  ]);
});

test("an unreadable hook file is reported with its path", async () => {
  const f = await fixture();
  const dir = await f.plugin("broken", {
    ".claude-plugin/plugin.json": { name: "broken" },
    "hooks/hooks.json": "{not json",
  });
  const loaded = await f.load([dir]);
  assert.equal(loaded.diagnostics.length, 1);
  assert.match(
    loaded.diagnostics[0] ?? "",
    /^broken@inline: SyntaxError: .* \(.*\/hooks\/hooks\.json\)$/,
  );
});

test("inline manifest hooks register without a file path; file hooks carry theirs", async () => {
  const f = await fixture();
  const dir = await f.plugin("both", {
    ".claude-plugin/plugin.json": { name: "both", hooks: stopHook },
    "hooks/hooks.json": { hooks: stopHook },
  });
  const loaded = await f.load([dir]);
  assert.deepEqual(loaded.diagnostics, []);
  assert.deepEqual(
    loaded.hookSources
      .map((source) => ({ ...source }))
      .sort((a, b) => String(a.path).localeCompare(String(b.path))),
    [
      {
        source: "plugin",
        hooks: stopHook,
        pluginRoot: dir,
        path: join(dir, "hooks", "hooks.json"),
      },
      { source: "plugin", hooks: stopHook, pluginRoot: dir },
    ],
  );
});

test("an LSP declaration is reported as not yet supported", async () => {
  const f = await fixture();
  const dir = await f.plugin("lsp", {
    ".claude-plugin/plugin.json": { name: "lsp" },
    ".lsp.json": { ts: { command: "tsserver" } },
  });
  const loaded = await f.load([dir]);
  assert.deepEqual(
    loaded.plugins.map((plugin) => plugin.name),
    ["lsp"],
  );
  assert.deepEqual(loaded.diagnostics, [
    "lsp@inline: LSP registration is not yet implemented",
  ]);
});

test("an aborted signal stops loading before any directory is read", async () => {
  const f = await fixture();
  const dir = await f.plugin("a", {});
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await assert.rejects(f.load([dir], controller.signal), /stop/);
});

test("a live signal is honoured through the catalog and component reads", async () => {
  const f = await fixture();
  const dir = await f.plugin("live", {
    ".claude-plugin/plugin.json": { name: "live" },
    "commands/hello.md": "Say hello",
  });
  const loaded = await f.load([dir], new AbortController().signal);
  assert.deepEqual(
    loaded.prompts.map((prompt) => prompt.info.name),
    ["live:hello"],
  );
});
