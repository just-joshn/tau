import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, onTestFinished } from "bun:test";
import { loadLaunchConfiguration } from "../../src/launch-configuration.js";
import { parseOptions } from "../../src/options.js";

test("launch resolves source order, flag/policy precedence, env/CLI model and trust-aware rules", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-launch-config-")),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "work"),
    user = join(root, "user"),
    managed = join(root, "managed");
  for (const path of [join(cwd, ".claude"), user, managed])
    await mkdir(path, { recursive: true });
  await writeFile(
    join(user, "settings.json"),
    JSON.stringify({ model: "user", permissions: { deny: ["Write"] } }),
  );
  await writeFile(
    join(cwd, ".claude/settings.json"),
    JSON.stringify({
      model: "project",
      permissions: { allow: ["Write"], deny: ["Edit"] },
    }),
  );
  await writeFile(
    join(cwd, ".claude/settings.local.json"),
    JSON.stringify({ model: "local", permissions: { allow: ["Edit"] } }),
  );
  const env = { CLAUDE_CONFIG_DIR: user, TAU_MANAGED_ROOT: managed };
  const options = {
    ...parseOptions([]),
    model: "default",
    modelExplicit: false,
  };
  const run = (extra = {}, childEnv: NodeJS.ProcessEnv = env) =>
    loadLaunchConfiguration(
      { ...options, ...extra },
      { cwd, env: childEnv, homeDirectory: root, nonInteractive: true },
    );
  const ordinary = await run();
  assert.equal(ordinary.model, "local");
  assert.deepEqual(
    ordinary.snapshot.permissionRules.map((rule) => [
      rule.source,
      rule.behavior,
      rule.rule,
    ]),
    [
      ["userSettings", "deny", "Write"],
      ["projectSettings", "deny", "Edit"],
      ["localSettings", "allow", "Edit"],
    ],
  );
  assert.equal((await run({ settings: '{"model":"flag"}' })).model, "flag");
  assert.equal(
    (
      await run(
        { model: "environment" },
        { ...env, ANTHROPIC_MODEL: "environment" },
      )
    ).model,
    "environment",
  );
  assert.equal(
    (
      await run(
        { model: "explicit", modelExplicit: true },
        { ...env, ANTHROPIC_MODEL: "environment" },
      )
    ).model,
    "explicit",
  );
  assert.equal((await run({ settingSources: "" })).model, "default");
  const parent = await run({
    settingSources: "",
    settings: '{"model":"flag"}',
    managedSettings:
      '{"model":"parent","claudeMd":"discarded","permissions":{"allow":["Write"]}}',
  });
  assert.equal(parent.model, "flag");
  assert.equal(parent.snapshot.effective.claudeMd, undefined);
  assert.deepEqual(
    parent.snapshot.permissionRules.map((rule) => [
      rule.source,
      rule.behavior,
      rule.rule,
    ]),
    [["policySettings", "allow", "Write"]],
  );
  await writeFile(
    join(managed, "managed-settings.json"),
    JSON.stringify({ model: "administrator", permissions: { deny: ["Edit"] } }),
  );
  const firstWins = await run({
    managedSettings: '{"permissions":{"deny":["Read"]}}',
  });
  assert.equal(firstWins.model, "administrator");
  assert.equal(
    firstWins.snapshot.permissionRules.some(
      (rule) => rule.source === "policySettings" && rule.rule === "Read",
    ),
    false,
  );
  await writeFile(
    join(managed, "managed-settings.json"),
    JSON.stringify({
      parentSettingsBehavior: "merge",
      allowManagedPermissionRulesOnly: true,
      permissions: { deny: ["Edit"] },
    }),
  );
  const merged = await run({
    managedSettings: '{"permissions":{"allow":["Write"],"deny":["Read"]}}',
  });
  assert.deepEqual(
    merged.snapshot.permissionRules.map((rule) => [rule.behavior, rule.rule]),
    [
      ["deny", "Read"],
      ["deny", "Edit"],
    ],
  );
  await assert.rejects(
    run({ settingSources: "managed" }),
    /Invalid setting source/,
  );
  await assert.rejects(run({ settings: "{broken" }), /Invalid inline settings/);
});
