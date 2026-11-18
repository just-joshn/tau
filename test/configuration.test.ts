import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  enabledSettingsSources,
  mergeSettings,
  resolveConfiguration,
  SETTINGS_MAX_BYTES,
  type ConfigurationOptions,
} from "../src/configuration.js";

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-configuration-")),
  );
  const cwd = join(root, "repo", "work"),
    user = join(root, "user"),
    managed = join(root, "managed"),
    local = join(root, "repo"),
    legacy = cwd;
  await mkdir(cwd, { recursive: true });
  const write = async (path: string, value: unknown) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      typeof value === "string" ? value : JSON.stringify(value),
    );
  };
  const options: ConfigurationOptions = {
    cwd,
    userConfigDir: user,
    managedRoot: managed,
    localStoreRoot: local,
    legacyLocalRoot: legacy,
    permissionTrust: { projectAllows: true, localAllows: true },
  };
  return {
    root,
    cwd,
    user,
    managed,
    local,
    legacy,
    write,
    options,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("configuration completes ordered user/project/legacy/local/flag/managed merge with source provenance", async () => {
  const f = await fixture();
  try {
    await f.write(join(f.user, "settings.json"), {
      model: "user",
      env: { A: "user", KEEP: "yes" },
      permissions: { allow: ["Read"], deny: ["Write(private/**)"] },
      fallbackModel: ["user-fallback"],
      list: ["same", "user"],
      unknown: { preserved: true },
    });
    await f.write(join(f.cwd, ".claude/settings.json"), {
      model: "project",
      env: { A: "project" },
      permissions: { allow: ["Read", "Grep"] },
      list: ["same", "project"],
    });
    await f.write(join(f.legacy, ".claude/settings.local.json"), {
      model: "legacy",
      env: { LEGACY: "yes" },
    });
    await f.write(join(f.local, ".claude/settings.local.json"), {
      model: "local",
      env: { A: "local" },
    });
    await f.write(join(f.managed, "managed-settings.json"), {
      model: "managed",
      fallbackModel: ["managed-fallback"],
      permissions: { ask: ["Bash"] },
    });
    await f.write(join(f.managed, "managed-settings.d/20-final.json"), {
      model: "last",
      env: { ORDER: "20" },
    });
    await f.write(join(f.managed, "managed-settings.d/10-first.json"), {
      env: { ORDER: "10" },
    });
    await f.write(join(f.managed, "managed-settings.d/.ignored.json"), {
      model: "wrong",
    });
    const result = await resolveConfiguration({
      ...f.options,
      flag: {
        inline: {
          model: "flag",
          fallbackModel: ["flag-fallback"],
          env: { FLAG: "yes" },
        },
      },
    });
    assert.equal(result.effective.model, "last");
    assert.deepEqual(result.effective.env, {
      A: "local",
      KEEP: "yes",
      LEGACY: "yes",
      FLAG: "yes",
      ORDER: "20",
    });
    assert.deepEqual(result.effective.list, ["same", "user", "project"]);
    assert.deepEqual(result.effective.fallbackModel, ["managed-fallback"]);
    assert.deepEqual(result.effective.unknown, { preserved: true });
    assert.deepEqual(
      result.documents.map((document) => document.source),
      [
        "userSettings",
        "projectSettings",
        "localSettings",
        "localSettings",
        "flagSettings",
        "policySettings",
        "policySettings",
        "policySettings",
      ],
    );
    assert.deepEqual(
      result.permissionRules.map(({ source, behavior, rule }) => [
        source,
        behavior,
        rule,
      ]),
      [
        ["userSettings", "allow", "Read"],
        ["userSettings", "deny", "Write(private/**)"],
        ["projectSettings", "allow", "Read"],
        ["projectSettings", "allow", "Grep"],
        ["policySettings", "ask", "Bash"],
      ],
    );
    assert.equal(result.provenance["env.A"]?.length, 3);
    assert.equal(
      result.documents.every((document) => !document.schemaValidated),
      true,
    );
    assert.match(
      result.limitations.join(" "),
      /Generic JSON.*remote\/MDM\/helper/,
    );
  } finally {
    await f.close();
  }
});

test("source selection is fixed-order membership and cannot disable flag or policy", async () => {
  assert.deepEqual(enabledSettingsSources(" local, user "), [
    "userSettings",
    "localSettings",
    "flagSettings",
    "policySettings",
  ]);
  assert.deepEqual(enabledSettingsSources(""), [
    "flagSettings",
    "policySettings",
  ]);
  assert.throws(
    () => enabledSettingsSources("managed"),
    /Invalid setting source/,
  );
  assert.throws(
    () => enabledSettingsSources("user,"),
    /Invalid setting source/,
  );
  const f = await fixture();
  try {
    await f.write(join(f.user, "settings.json"), { model: "must not load" });
    const result = await resolveConfiguration({
      cwd: f.cwd,
      userConfigDir: f.user,
      allowedSources: "",
      permissionTrust: f.options.permissionTrust,
      flag: { inline: { model: "flag", env: { FROM_FLAG: "yes" } } },
      policy: { inline: { model: "policy" } },
    });
    assert.equal(result.effective.model, "policy");
    assert.deepEqual(result.effective.env, { FROM_FLAG: "yes" });
    assert.deepEqual(
      result.documents.map((document) => document.source),
      ["flagSettings", "policySettings"],
    );
  } finally {
    await f.close();
  }
});

test("merge replaces modelPicker/fallback nodes and server entries, while keeping normal object recursion", () => {
  const before = {
    modelPicker: { options: ["old"], extra: true },
    fallbackModel: ["old"],
    managedMcpServers: {
      server: { url: "old", headers: { SECRET: "old" } },
      keep: { url: "keep" },
    },
    extraKnownMarketplaces: { market: { source: "old", retained: true } },
    nested: { keep: true },
    values: [1, "a"],
  };
  const result = mergeSettings(before, {
    modelPicker: { options: [] },
    fallbackModel: [],
    managedMcpServers: { server: { url: "new" } },
    extraKnownMarketplaces: { market: { source: "new" } },
    nested: { added: true },
    values: [1, "b"],
  });
  assert.deepEqual(result.modelPicker, { options: [] });
  assert.deepEqual(result.fallbackModel, []);
  assert.deepEqual(result.managedMcpServers, {
    server: { url: "new" },
    keep: { url: "keep" },
  });
  assert.deepEqual(result.extraKnownMarketplaces, {
    market: { source: "new" },
  });
  assert.deepEqual(result.nested, { keep: true, added: true });
  assert.deepEqual(result.values, [1, "a", "b"]);
  assert.equal(before.managedMcpServers.server.url, "old");
});

test("source trust filters allow records while retaining project/local restrictions; managed-only gates all lower rules", async () => {
  const f = await fixture();
  try {
    await f.write(join(f.user, "settings.json"), {
      permissions: { allow: ["Read"] },
    });
    await f.write(join(f.cwd, ".claude/settings.json"), {
      permissions: { allow: ["Bash"], deny: ["Write"], ask: ["Grep"] },
    });
    await f.write(join(f.local, ".claude/settings.local.json"), {
      permissions: { allow: ["Edit"], deny: ["Bash(rm *)"] },
    });
    const result = await resolveConfiguration({
      ...f.options,
      permissionTrust: { projectAllows: false, localAllows: false },
    });
    assert.deepEqual(
      result.permissionRules.map(({ behavior, rule }) => [behavior, rule]),
      [
        ["allow", "Read"],
        ["deny", "Write"],
        ["ask", "Grep"],
        ["deny", "Bash(rm *)"],
      ],
    );
    await f.write(join(f.managed, "managed-settings.json"), {
      allowManagedPermissionRulesOnly: true,
      permissions: { allow: ["Grep"], deny: ["Write"] },
    });
    const locked = await resolveConfiguration(f.options);
    assert.deepEqual(
      locked.permissionRules.map(({ source, rule }) => [source, rule]),
      [
        ["policySettings", "Grep"],
        ["policySettings", "Write"],
      ],
    );
  } finally {
    await f.close();
  }
});

test("managed model lists override lower additive lists and deniedModels is policy-only", async () => {
  const f = await fixture();
  try {
    const base = {
      cwd: f.cwd,
      allowedSources: "",
      permissionTrust: f.options.permissionTrust,
      flag: {
        inline: { availableModels: ["lower"], deniedModels: ["ignored"] },
      },
    } as const;
    assert.equal(
      (await resolveConfiguration(base)).effective.deniedModels,
      undefined,
    );
    const result = await resolveConfiguration({
      ...base,
      policy: {
        inline: { availableModels: ["managed"], deniedModels: ["blocked"] },
      },
    });
    assert.deepEqual(result.effective.availableModels, ["managed"]);
    assert.deepEqual(result.effective.deniedModels, ["blocked"]);
  } finally {
    await f.close();
  }
});

test("configuration preserves absent/invalid/oversized states, schema/filter hooks and unknown keys", async () => {
  const f = await fixture();
  try {
    await f.write(join(f.user, "settings.json"), "not json");
    await f.write(
      join(f.local, ".claude/settings.local.json"),
      "x".repeat(SETTINGS_MAX_BYTES + 1),
    );
    const result = await resolveConfiguration({
      ...f.options,
      validate(value) {
        if (value.bad) throw new Error("fixture schema rejection");
        return value;
      },
      filterSource(value, origin) {
        return origin.source === "flagSettings"
          ? { ...value, filtered: true }
          : value;
      },
      flag: [
        { inline: { preserved: { any: "key" } } },
        { inline: { bad: true } },
      ],
    });
    assert.equal(
      result.documents.find((document) => document.source === "userSettings")
        ?.status,
      "invalid",
    );
    assert.equal(
      result.documents.find((document) => document.source === "projectSettings")
        ?.status,
      "absent",
    );
    assert.equal(
      result.documents.find(
        (document) =>
          document.path === join(f.local, ".claude/settings.local.json"),
      )?.status,
      "withheld",
    );
    assert.deepEqual(result.effective.preserved, { any: "key" });
    assert.equal(result.effective.filtered, true);
    assert.equal(result.effective.bad, undefined);
    assert.match(
      result.diagnostics.map((diagnostic) => diagnostic.message).join(" "),
      /fixture schema rejection/,
    );
    assert.equal(
      result.documents.every((document) => document.schemaValidated),
      true,
    );
  } finally {
    await f.close();
  }
});

test("explicit roots avoid ancestor settings discovery and dedupe a user/project file alias", async () => {
  const f = await fixture();
  try {
    await f.write(join(f.local, ".claude/settings.json"), { ancestor: true });
    await f.write(join(f.cwd, ".claude/settings.json"), { current: true });
    const result = await resolveConfiguration({
      cwd: f.cwd,
      userConfigDir: join(f.cwd, ".claude"),
      permissionTrust: f.options.permissionTrust,
    });
    assert.equal(result.effective.ancestor, undefined);
    assert.equal(result.effective.current, true);
    assert.equal(
      result.documents.filter(
        (document) => document.path === join(f.cwd, ".claude/settings.json"),
      ).length,
      1,
    );
    await assert.rejects(
      resolveConfiguration({ ...f.options, cwd: "relative" }),
      /must be absolute/,
    );
  } finally {
    await f.close();
  }
});

test("read policy and safe merging resist special keys without changing process prototypes", async () => {
  const f = await fixture();
  try {
    await f.write(join(f.user, "settings.json"), { forbidden: true });
    const inline: unknown = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"data":"preserved"}}',
    );
    const result = await resolveConfiguration({
      ...f.options,
      readPolicy: (path) => (path.startsWith(f.user) ? "fixture policy" : true),
      flag: { inline },
    });
    assert.equal(result.effective.forbidden, undefined);
    assert.equal(Object.getPrototypeOf(result.effective), Object.prototype);
    const plain: Record<string, unknown> = {};
    assert.equal(plain.polluted, undefined);
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(result.effective, "__proto__")?.value,
      { polluted: true },
    );
    assert.equal(result.documents[0]?.status, "withheld");
  } finally {
    await f.close();
  }
});

test("multiple documents in one source compose before rule parsing and do not duplicate rules", async () => {
  const f = await fixture();
  try {
    const result = await resolveConfiguration({
      cwd: f.cwd,
      allowedSources: "",
      permissionTrust: f.options.permissionTrust,
      policy: [
        { inline: { permissions: { allow: ["Read"], deny: ["Write"] } } },
        {
          inline: { permissions: { allow: ["Read", "Grep"], deny: ["Write"] } },
        },
      ],
    });
    assert.deepEqual(
      result.permissionRules.map(({ behavior, rule }) => [behavior, rule]),
      [
        ["allow", "Read"],
        ["allow", "Grep"],
        ["deny", "Write"],
      ],
    );
  } finally {
    await f.close();
  }
});

test("settings JSON accepts a leading UTF-8 BOM but does not guess JSONC syntax", async () => {
  const f = await fixture();
  try {
    await f.write(join(f.user, "settings.json"), '\uFEFF{"model":"bom"}');
    assert.equal(
      (await resolveConfiguration(f.options)).effective.model,
      "bom",
    );
    await f.write(
      join(f.user, "settings.json"),
      '{/* not JSON */"model":"comment"}',
    );
    const result = await resolveConfiguration(f.options);
    assert.equal(result.documents[0]?.status, "invalid");
  } finally {
    await f.close();
  }
});
