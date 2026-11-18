import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import type { LocalAgentDefinition } from "../../src/agent-definitions.js";
import { createLaunchAgentMemoryHost } from "../../src/agent-memory-launch.js";
import { loadLaunchConfiguration } from "../../src/launch-configuration.js";
import { parseOptions } from "../../src/options.js";
import {
  combineToolPolicy,
  parseToolPolicy,
  type ToolPolicy,
} from "../../src/tool-policy.js";
import type { PermissionMode } from "../../src/types.js";

interface FixtureOptions {
  env?: NodeJS.ProcessEnv;
  userSettings?: Record<string, unknown>;
  trusted?: boolean;
  remoteProjectKey?: string;
}

async function fixture(options: FixtureOptions = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-memory-launch-")),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "work"),
    config = join(root, "config");
  await mkdir(cwd);
  await mkdir(config);
  if (options.userSettings)
    await writeFile(
      join(config, "settings.json"),
      JSON.stringify(options.userSettings),
    );
  const launch = await loadLaunchConfiguration(parseOptions([]), {
    cwd,
    homeDirectory: root,
    nonInteractive: true,
    workspaceTrustAccepted: options.trusted ?? true,
    env: { CLAUDE_CONFIG_DIR: config, TAU_MANAGED_ROOT: join(root, "managed") },
  });
  const host = createLaunchAgentMemoryHost({
    cwd,
    launch,
    model: () => "claude-test",
    env: options.env ?? {},
    ...(options.remoteProjectKey === undefined
      ? {}
      : { remoteProjectKey: options.remoteProjectKey }),
  });
  const memory = join(cwd, ".claude", "agent-memory", "owned");
  await mkdir(memory, { recursive: true });
  return { root, cwd, config, host, memory };
}

type Host = Awaited<ReturnType<typeof fixture>>["host"];

/** Whether the memory stage allows `operation` on `path` without a prompt. */
function allows(
  host: Host,
  operation: "Read" | "Write" | "Edit",
  path: string,
  policy: ToolPolicy = parseToolPolicy({}),
  mode: PermissionMode = "default",
) {
  return host
    .fileAccess(
      () => policy,
      () => mode,
    )
    .memoryFileAllowance({
      operation,
      requestedPath: path,
      canonicalPath: path,
      signal: new AbortController().signal,
    });
}

const definition = (
  patch: Partial<LocalAgentDefinition> = {},
): LocalAgentDefinition => ({
  agentType: "owned",
  source: "projectSettings",
  prompt: "OWNED MEMORY AGENT",
  whenToUse: "Owned",
  skills: [],
  memory: "project",
  ...patch,
});

test("INV-01 memory writes are allowed only while the session permits the tool without asking", async () => {
  const f = await fixture();
  const notes = join(f.memory, "notes.md");
  assert.equal(await allows(f.host, "Write", notes), true);
  assert.equal(await allows(f.host, "Read", notes), true);
  assert.equal(
    await allows(f.host, "Write", notes, parseToolPolicy({}), "plan"),
    false,
  );
  for (const policy of [
    parseToolPolicy({ tools: "Read,Edit" }),
    parseToolPolicy({ disallowedTools: ["Write"] }),
    combineToolPolicy(parseToolPolicy({}), [
      { source: "userSettings", behavior: "ask", rule: "Write" },
    ]),
    // Inherited Read denies also protect Write and Edit.
    combineToolPolicy(parseToolPolicy({}), [
      { source: "userSettings", behavior: "deny", rule: "Read" },
    ]),
  ])
    assert.equal(
      await allows(f.host, "Write", notes, policy),
      false,
      JSON.stringify(policy),
    );
  // A CLI Read deny is not an inherited settings deny; it leaves Read only.
  assert.equal(
    await allows(
      f.host,
      "Write",
      notes,
      parseToolPolicy({ disallowedTools: ["Read"] }),
    ),
    true,
  );
});

test("INV-06 memory writes never reach a hard-linked file or through a symlink", async () => {
  const f = await fixture();
  const outside = join(f.root, "outside.md");
  await writeFile(outside, "outside\n");
  const linked = join(f.memory, "linked.md");
  await link(outside, linked);
  assert.equal(await allows(f.host, "Write", linked), false);
  const target = join(f.memory, "target.md");
  await writeFile(target, "inside\n");
  const alias = join(f.memory, "alias.md");
  await symlink(target, alias);
  assert.equal(await allows(f.host, "Edit", alias), false);
  // A leaf that is neither missing nor inspectable is not a safe target.
  const file = join(f.memory, "file.md");
  await writeFile(file, "plain\n");
  assert.equal(await allows(f.host, "Write", join(file, "child.md")), false);
  // A symlink loop has no identity to check, so the allowance fails closed.
  const loop = join(f.memory, "loop.md");
  await symlink(loop, loop);
  await assert.rejects(
    allows(f.host, "Write", loop),
    /memory file identity is unresolved/,
  );
});

test("INV-06 a remote memory directory replaces the configuration directory for user memory", async () => {
  const remote = "remote-memory";
  const f = await fixture({
    env: { CLAUDE_CODE_REMOTE_MEMORY_DIR: remote },
    remoteProjectKey: "project-key",
  });
  const remoteUser = join(f.cwd, remote, "agent-memory", "owned");
  await mkdir(remoteUser, { recursive: true });
  assert.equal(
    await allows(f.host, "Write", join(remoteUser, "notes.md")),
    true,
  );
  assert.equal(
    await allows(
      f.host,
      "Write",
      join(f.config, "agent-memory", "owned", "notes.md"),
    ),
    false,
  );
  const unkeyed = await fixture({
    env: { CLAUDE_CODE_REMOTE_MEMORY_DIR: remote },
  });
  const unkeyedUser = join(unkeyed.cwd, remote, "agent-memory", "owned");
  await mkdir(unkeyedUser, { recursive: true });
  assert.equal(
    await allows(unkeyed.host, "Write", join(unkeyedUser, "notes.md")),
    true,
  );
});

test("the autoMemoryEnabled setting decides whether agent memory is enabled", async () => {
  for (const enabled of [true, false]) {
    const f = await fixture({ userSettings: { autoMemoryEnabled: enabled } });
    assert.deepEqual(f.host.registryOptions(), { memoryEnabled: enabled });
  }
  assert.deepEqual((await fixture()).host.registryOptions(), {
    memoryEnabled: true,
  });
});

test("project agent definitions get memory only in a trusted workspace", async () => {
  const signal = new AbortController().signal;
  const trusted = await fixture();
  assert.equal(
    (await trusted.host.prepare(definition(), signal)).enabled,
    true,
  );
  const untrusted = await fixture({ trusted: false });
  await assert.rejects(
    untrusted.host.prepare(definition(), signal),
    /definition admission denied/,
  );
  assert.equal(
    (
      await untrusted.host.prepare(
        definition({ source: "userSettings", memory: "user" }),
        signal,
      )
    ).enabled,
    true,
  );
});
