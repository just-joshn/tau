import { test, onTestFinished } from "bun:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfiguration } from "../../src/configuration.js";
import { combineToolPolicy, parseToolPolicy } from "../../src/tool-policy.js";
import { createTools } from "../../src/tools.js";

test("disposable settings files resolve trust/managed composition into actual permission dispatch", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-settings-permissions-")),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "repo"),
    user = join(root, "user"),
    managed = join(root, "managed");
  await mkdir(join(cwd, ".claude"), { recursive: true });
  await mkdir(user);
  await mkdir(managed);
  await writeFile(
    join(user, "settings.json"),
    JSON.stringify({ permissions: { allow: ["Write"], deny: ["Bash"] } }),
  );
  await writeFile(
    join(cwd, ".claude/settings.json"),
    JSON.stringify({ permissions: { allow: ["Bash"], ask: ["Read"] } }),
  );
  await writeFile(
    join(cwd, ".claude/settings.local.json"),
    JSON.stringify({ permissions: { deny: ["Edit"] } }),
  );
  await writeFile(join(cwd, "data.txt"), "existing");
  const config = {
    cwd,
    userConfigDir: user,
    managedRoot: managed,
    permissionTrust: { projectAllows: false, localAllows: false },
  };
  const snapshot = await resolveConfiguration(config);
  assert.equal(
    snapshot.permissionRules.some(
      (rule) => rule.source === "projectSettings" && rule.behavior === "allow",
    ),
    false,
  );
  const policy = combineToolPolicy(
    parseToolPolicy({}),
    snapshot.permissionRules,
  );
  let prompts = 0;
  const tools = createTools({
    cwd,
    mode: "default",
    policy,
    approve: async () => {
      prompts++;
      return false;
    },
  });
  const run = (name: string, input: unknown) =>
    tools.execute(
      { type: "tool_use", id: name, name, input },
      new AbortController().signal,
    );
  assert.equal(
    (
      await run("Write", {
        file_path: "new.txt",
        content: "allowed by user settings",
      })
    ).is_error,
    undefined,
  );
  assert.equal(prompts, 0);
  assert.equal(
    (await run("Read", { file_path: "data.txt" })).permissionDenied,
    true,
  );
  assert.equal(prompts, 1);
  assert.equal(
    (await run("Bash", { command: "printf forbidden" })).permissionDenied,
    true,
  );
  assert.equal(prompts, 1);
  assert.equal(
    (
      await run("Edit", {
        file_path: "new.txt",
        old_string: "allowed",
        new_string: "bad",
      })
    ).permissionDenied,
    true,
  );
  assert.equal(
    await readFile(join(cwd, "new.txt"), "utf8"),
    "allowed by user settings",
  );

  await writeFile(
    join(managed, "managed-settings.json"),
    JSON.stringify({
      allowManagedPermissionRulesOnly: true,
      permissions: { allow: ["Write"], deny: ["Read"] },
    }),
  );
  const locked = await resolveConfiguration(config);
  assert.equal(
    locked.permissionRules.every((rule) => rule.source === "policySettings"),
    true,
  );
  const lockedTools = createTools({
    cwd,
    mode: "bypassPermissions",
    policy: combineToolPolicy(
      parseToolPolicy({ allowedTools: ["Write"] }),
      locked.permissionRules,
    ),
    approve: async () => true,
  });
  const blocked = await lockedTools.execute(
    {
      type: "tool_use",
      id: "locked",
      name: "Write",
      input: { file_path: "new-protected.txt", content: "blocked" },
    },
    new AbortController().signal,
  );
  assert.equal(blocked.permissionDenied, true);
  assert.match(blocked.content, /Read deny rule/);
});
