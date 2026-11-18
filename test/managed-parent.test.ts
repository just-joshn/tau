import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  composeFileManagedParentSettings,
  projectManagedParentSettings,
} from "../src/managed-parent.js";
import type { JsonValue, SettingsRecord } from "../src/configuration.js";

const isRecord = (value: JsonValue | undefined): value is SettingsRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function permissions(settings: SettingsRecord): SettingsRecord {
  const value = settings.permissions;
  assert.ok(isRecord(value));
  return value;
}

test("parent projection excludes model/instructions/environment while retaining conditional grants and restrictions", () => {
  assert.deepEqual(
    projectManagedParentSettings({
      model: "parent-model",
      claudeMd: "parent instructions",
      env: { TOKEN: "dummy" },
      organizationFreeFormSettings: { model: "org-model" },
      hooks: {},
      permissions: {
        allow: ["Read", "Write"],
        deny: ["Read"],
        ask: ["Bash"],
        defaultMode: "bypassPermissions",
        additionalDirectories: ["/fixture"],
      },
    }),
    {
      permissions: {
        allow: ["Read", "Write"],
        deny: ["Read"],
        ask: ["Bash"],
        additionalDirectories: ["/fixture"],
      },
    },
  );
});
test("higher managed locks filter grants without allowing a parent's own locks to suppress its policy rules", () => {
  const parent = {
    allowManagedPermissionRulesOnly: true,
    permissions: {
      allow: ["Read"],
      deny: ["Write"],
      additionalDirectories: ["/fixture"],
    },
    sandbox: {
      network: {
        allowedDomains: ["fixture.invalid"],
        deniedDomains: ["blocked.invalid"],
      },
      filesystem: { allowRead: ["/fixture"], denyRead: ["/secret"] },
    },
  };
  assert.deepEqual(
    projectManagedParentSettings(parent, {
      allowManagedPermissionRulesOnly: true,
      sandbox: {
        network: { allowManagedDomainsOnly: true },
        filesystem: { allowManagedReadPathsOnly: true },
      },
    }),
    {
      allowManagedPermissionRulesOnly: true,
      permissions: { deny: ["Write"] },
      sandbox: {
        network: { deniedDomains: ["blocked.invalid"] },
        filesystem: { denyRead: ["/secret"] },
      },
    },
  );
  assert.deepEqual(permissions(projectManagedParentSettings(parent)).allow, [
    "Read",
  ]);
  assert.equal(
    permissions(
      projectManagedParentSettings(parent, {
        sandbox: { network: { allowManagedDomainsOnly: true } },
      }),
    ).allow,
    undefined,
  );
  assert.deepEqual(
    permissions(
      projectManagedParentSettings(parent, {
        sandbox: { network: { allowManagedDomainsOnly: true } },
      }),
    ).additionalDirectories,
    ["/fixture"],
  );
});
test("parent path exceptions cannot subtract deny/ask restrictions", () => {
  assert.deepEqual(
    projectManagedParentSettings({
      permissions: {
        deny: [
          "Read(!secret)",
          "Edit(./!secret)",
          "Read(/secret)",
          "Bash(!command)",
        ],
        ask: ["Read(./!public)", "Write"],
      },
    }),
    {
      permissions: {
        deny: ["Read(/secret)", "Bash(!command)"],
        ask: ["Write"],
      },
    },
  );
});
test("parent allowlists never replace an occupied managed list, including an empty list", () => {
  const parent = {
    availableModels: ["parent"],
    allowedMcpServers: [],
    forceLoginOrgUUID: "parent-pin",
    strictKnownMarketplaces: [],
    allowedProviders: ["firstParty"],
  };
  assert.deepEqual(
    projectManagedParentSettings(parent, {
      availableModels: [],
      forceLoginOrgUUID: "admin-pin",
    }),
    {
      allowedMcpServers: [],
      strictKnownMarketplaces: [],
      allowedProviders: ["firstParty"],
    },
  );
});
test("hook restrictions and disabling flags are projected only in their restrictive directions", () => {
  assert.deepEqual(
    projectManagedParentSettings({
      disableAllHooks: true,
      disableRemoteControl: false,
      disableSideloadFlags: true,
      syncClaudeAiSkills: true,
      syncClaudeAiPlugins: false,
      allowedHttpHookUrls: [],
      httpHookAllowedEnvVars: [],
      enableWorkflows: false,
      disableAutoMode: "disable",
      permissions: {
        disableBypassPermissionsMode: "disable",
        denyInsteadOfPrompting: true,
      },
    }),
    {
      allowManagedHooksOnly: true,
      disableSideloadFlags: true,
      syncClaudeAiPlugins: false,
      enableWorkflows: false,
      allowedHttpHookUrls: [],
      httpHookAllowedEnvVars: [],
      disableAutoMode: "disable",
      permissions: {
        disableBypassPermissionsMode: "disable",
        denyInsteadOfPrompting: true,
      },
    },
  );
  assert.deepEqual(
    projectManagedParentSettings(
      { allowedHttpHookUrls: [], httpHookAllowedEnvVars: [] },
      { enabledPlugins: { fixture: true } },
    ),
    {},
  );
});
test("parent sandbox settings preserve only restrictive scalar directions and selected path/domain sets", () => {
  assert.deepEqual(
    projectManagedParentSettings({
      sandbox: {
        enabled: true,
        failIfUnavailable: false,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        network: {
          allowLocalBinding: false,
          strictAllowlist: true,
          allowedDomains: [],
        },
        filesystem: {
          allowWrite: ["/discarded"],
          denyWrite: ["/kept"],
          disabled: true,
        },
        enabledPlatforms: ["macos"],
      },
    }),
    {
      sandbox: {
        enabled: true,
        allowUnsandboxedCommands: false,
        network: {
          allowLocalBinding: false,
          strictAllowlist: true,
          allowedDomains: [],
        },
        filesystem: { denyWrite: ["/kept"] },
      },
    },
  );
});
test("parent credentials cannot inject masked secrets and conventional AWS references become inert suppressors", () => {
  assert.deepEqual(
    projectManagedParentSettings({
      sandbox: {
        credentials: {
          files: [
            { path: "/deny", mode: "deny" },
            {
              path: "/mask",
              mode: "mask",
              injectHosts: ["discarded.invalid"],
              extract: "secret",
            },
          ],
          envVars: [
            { name: "DENIED", mode: "deny" },
            { name: "MASKED", mode: "mask" },
          ],
          allowPlaintextInject: true,
          sigv4: { streaming: "deny", presigned: "passthrough" },
          awsPairs: [
            {
              accessKeyIdVar: "AWS_ACCESS_KEY_ID",
              secretAccessKeyVar: "AWS_SECRET_ACCESS_KEY",
              sessionTokenVar: "AWS_SESSION_TOKEN",
            },
            { accessKeyIdVar: "CUSTOM", secretAccessKeyVar: "CUSTOM_SECRET" },
          ],
        },
      },
    }),
    {
      sandbox: {
        credentials: {
          files: [
            { path: "/deny", mode: "deny" },
            { path: "/mask", mode: "mask", injectHosts: [] },
          ],
          envVars: [{ name: "DENIED", mode: "deny" }],
          sigv4: { streaming: "deny" },
          awsPairs: [
            {
              accessKeyIdVar: "AWS_ACCESS_KEY_ID",
              secretAccessKeyVar: "_PARENT_PAIR_SUPPRESSOR_1_",
            },
            {
              accessKeyIdVar: "AWS_SECRET_ACCESS_KEY",
              secretAccessKeyVar: "_PARENT_PAIR_SUPPRESSOR_2_",
            },
            {
              accessKeyIdVar: "AWS_SESSION_TOKEN",
              secretAccessKeyVar: "_PARENT_PAIR_SUPPRESSOR_3_",
            },
          ],
        },
      },
    },
  );
});
test("projection is independent of inputs and legacy attribution precedence matches the source", () => {
  const parent: SettingsRecord = {
    permissions: { allow: ["Read"] },
    attribution: { commitTrailers: true, commit: "", sessionUrl: false },
    includeCoAuthoredBy: false,
    remoteControl: { shareHostProfile: "basic", other: true },
  };
  const result = projectManagedParentSettings(parent);
  assert.deepEqual(result.attribution, { sessionUrl: false });
  assert.deepEqual(result.remoteControl, { shareHostProfile: "basic" });
  const allow = permissions(result).allow;
  assert.ok(Array.isArray(allow));
  allow.push("Write");
  assert.deepEqual(permissions(parent).allow, ["Read"]);
  assert.deepEqual(
    projectManagedParentSettings({ includeCoAuthoredBy: false }).attribution,
    { commitTrailers: false },
  );
});

test("a valid authored filesystem administrator excludes the whole parent by default", () => {
  const parent = {
    model: "ignored",
    permissions: { deny: ["Read"], allow: ["Edit"] },
  };
  assert.deepEqual(
    composeFileManagedParentSettings(
      { model: "admin", permissions: { deny: ["Write"] } },
      parent,
    ),
    {
      settings: { model: "admin", permissions: { deny: ["Write"] } },
      projectedParent: {},
      parentAdmitted: false,
    },
  );
  assert.deepEqual(composeFileManagedParentSettings({}, parent), {
    settings: { permissions: { deny: ["Read"], allow: ["Edit"] } },
    projectedParent: { permissions: { deny: ["Read"], allow: ["Edit"] } },
    parentAdmitted: true,
  });
  assert.equal(
    composeFileManagedParentSettings(
      { managedSourcesBehavior: "merge", wslInheritsWindowsSettings: false },
      parent,
    ).parentAdmitted,
    true,
  );
});

test("explicit parent merge composes parent before administrator with additive rule order and occupied allowlist locks", () => {
  const admin = {
    parentSettingsBehavior: "merge",
    model: "admin",
    availableModels: [],
    permissions: { allow: ["Write"], deny: ["Edit", "Read"] },
  };
  const parent = {
    model: "parent",
    availableModels: ["parent"],
    permissions: { allow: ["Read"], deny: ["Read"] },
  };
  const result = composeFileManagedParentSettings(admin, parent);
  assert.equal(result.parentAdmitted, true);
  assert.deepEqual(result.projectedParent, {
    permissions: { allow: ["Read"], deny: ["Read"] },
  });
  assert.deepEqual(result.settings, {
    parentSettingsBehavior: "merge",
    model: "admin",
    availableModels: [],
    permissions: { allow: ["Read", "Write"], deny: ["Read", "Edit"] },
  });
  assert.deepEqual(parent.permissions.deny, ["Read"]);
  assert.deepEqual(admin.permissions.deny, ["Edit", "Read"]);
});

test("composition reasserts the source's specific parent floors without inventing a blanket restrictive override", () => {
  const result = composeFileManagedParentSettings(
    {
      parentSettingsBehavior: "merge",
      disableRemoteControl: false,
      disableSkillShellExecution: false,
      disableSideloadFlags: false,
      enableWorkflows: true,
      availableModelsMatch: "default",
    },
    {
      disableRemoteControl: true,
      disableSkillShellExecution: true,
      disableSideloadFlags: true,
      enableWorkflows: false,
      availableModelsMatch: "exact",
    },
  );
  assert.equal(result.settings.disableRemoteControl, true);
  assert.equal(result.settings.disableSkillShellExecution, true);
  assert.equal(result.settings.enableWorkflows, false);
  assert.equal(result.settings.availableModelsMatch, "exact");
  assert.equal(result.settings.disableSideloadFlags, false);
});

test("host lineage default merge remains explicit and administrator first-wins still wins", () => {
  assert.equal(
    composeFileManagedParentSettings(
      { model: "admin" },
      { permissions: { deny: ["Read"] } },
      { defaultParentSettingsBehavior: "merge" },
    ).parentAdmitted,
    true,
  );
  assert.equal(
    composeFileManagedParentSettings(
      { parentSettingsBehavior: "first-wins", model: "admin" },
      { permissions: { deny: ["Read"] } },
      { defaultParentSettingsBehavior: "merge" },
    ).parentAdmitted,
    false,
  );
  assert.deepEqual(composeFileManagedParentSettings(null, null).settings, {});
  assert.deepEqual(
    composeFileManagedParentSettings(null, null, {
      rawParent: { disableAllHooks: "unreadable" },
    }).projectedParent,
    { allowManagedHooksOnly: true },
  );
});
