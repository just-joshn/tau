import type { JsonValue, SettingsRecord } from "./configuration.js";

function object(value: JsonValue | undefined): SettingsRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}
function copy(
  target: SettingsRecord,
  source: SettingsRecord,
  keys: readonly string[],
): void {
  for (const key of keys)
    if (source[key] !== undefined) target[key] = structuredClone(source[key]);
}
function put(
  target: SettingsRecord,
  path: readonly string[],
  value: JsonValue,
): void {
  let node = target;
  for (const key of path.slice(0, -1)) {
    const next = object(node[key]) ?? {};
    node[key] = next;
    node = next;
  }
  const last = path.at(-1);
  if (last !== undefined) node[last] = value;
}
function get(
  source: SettingsRecord,
  path: readonly string[],
): JsonValue | undefined {
  let value: JsonValue | undefined = source;
  for (const key of path) value = object(value)?.[key];
  return value;
}
const allowlists = [
  "allowedMcpServers",
  "availableModels",
  "strictKnownMarketplaces",
  "allowedProviders",
] as const;
const trueOnly = [
  "disableSkillShellExecution",
  "disableRemoteControl",
  "disableAgentView",
  "disableWorkflows",
  "disableArtifact",
  "disableCommandPluginSources",
  "disableSideloadFlags",
  "disableWindowsBashCommandSplit",
  "allowManagedMcpServersOnly",
  "disableClaudeAiConnectors",
  "allowManagedPermissionRulesOnly",
  "enforceAvailableModels",
] as const;
const falseOnly = [
  "enableWorkflows",
  "enableArtifact",
  "syncClaudeAiSkills",
  "syncClaudeAiPlugins",
] as const;
const sandboxFloors: ReadonlyArray<readonly [readonly string[], JsonValue]> = [
  [["enabled"], true],
  [["failIfUnavailable"], true],
  [["autoAllowBashIfSandboxed"], false],
  [["allowUnsandboxedCommands"], false],
  [["enableWeakerNestedSandbox"], false],
  [["enableWeakerNetworkIsolation"], false],
  [["allowAppleEvents"], false],
  [["allowNestedUserNamespaces"], false],
  [["network", "allowManagedDomainsOnly"], true],
  [["network", "strictAllowlist"], true],
  [["network", "allowAllUnixSockets"], false],
  [["network", "allowLocalBinding"], false],
  [["windows", "backend"], "sandboxuser"],
  [["filesystem", "allowManagedReadPathsOnly"], true],
  [["filesystem", "disabled"], false],
  [["credentials", "allowPlaintextInject"], false],
  [["credentials", "sigv4", "streaming"], "deny"],
  [["credentials", "sigv4", "presigned"], "deny"],
  [["credentials", "sigv4", "sigv4a"], "deny"],
];
const pathException = /^(?:Read|Edit)\((?:\.\/)?!/;

/**
 * Recovered REi projection for a parent document, not a filesystem/MDM policy.
 * Inputs are parsed settings documents; this does not implement the separate
 * tolerant policy schema or decide whether an administrator admits the parent.
 * `constraints` is the higher managed constraint view assembled by yD, not the
 * parent's own flags. `rawParent` preserves its fail-closed disableAllHooks hint.
 */
export function projectManagedParentSettings(
  parent: SettingsRecord,
  constraints: SettingsRecord = {},
  rawParent: SettingsRecord = parent,
): SettingsRecord {
  const result: SettingsRecord = {};
  const rawDisableHooks = rawParent.disableAllHooks;
  if (
    parent.allowManagedHooksOnly === true ||
    parent.disableAllHooks === true ||
    (rawDisableHooks !== undefined &&
      rawDisableHooks !== null &&
      rawDisableHooks !== false &&
      rawDisableHooks !== "false")
  )
    result.allowManagedHooksOnly = true;
  for (const key of trueOnly) if (parent[key] === true) result[key] = true;
  for (const key of falseOnly) if (parent[key] === false) result[key] = false;
  if (
    constraints.hooks === undefined &&
    !Object.values(object(constraints.enabledPlugins) ?? {}).some(
      (value) => value !== false && value !== undefined,
    )
  ) {
    for (const key of ["allowedHttpHookUrls", "httpHookAllowedEnvVars"])
      if (Array.isArray(parent[key]) && parent[key].length === 0)
        result[key] = [];
  }
  if (
    parent.disablePluginDirectory !== undefined &&
    parent.disablePluginDirectory !== false
  )
    result.disablePluginDirectory = true;
  if (parent.disableAutoMode === "disable") result.disableAutoMode = "disable";
  const remoteTools = object(parent.remoteTools);
  if (remoteTools?.allowUnattendedServing === false)
    result.remoteTools = { allowUnattendedServing: false };
  const share = object(parent.remoteControl)?.shareHostProfile;
  if (share === "off" || share === "basic")
    result.remoteControl = { shareHostProfile: share };
  const attribution = object(parent.attribution);
  const trailers = attribution?.commitTrailers;
  const attributionDisabled =
    typeof trailers === "boolean"
      ? !trailers
      : attribution !== undefined &&
          (attribution.commit !== undefined || attribution.pr !== undefined)
        ? attribution.commit === ""
        : parent.includeCoAuthoredBy !== undefined &&
          !parent.includeCoAuthoredBy;
  if (attributionDisabled) result.attribution = { commitTrailers: false };
  if (attribution?.sessionUrl === false)
    result.attribution = { ...object(result.attribution), sessionUrl: false };
  const strict = parent.strictPluginOnlyCustomization;
  if (strict === true || (Array.isArray(strict) && strict.length > 0))
    result.strictPluginOnlyCustomization = structuredClone(strict);
  if (parent.deniedMcpServers)
    result.deniedMcpServers = structuredClone(parent.deniedMcpServers);
  for (const key of ["blockedMarketplaces", "deniedModels"])
    if (Array.isArray(parent[key]) && parent[key].length > 0)
      result[key] = structuredClone(parent[key]);
  if (constraints.forceLoginOrgUUID === undefined && parent.forceLoginOrgUUID)
    result.forceLoginOrgUUID = structuredClone(parent.forceLoginOrgUUID);
  for (const key of allowlists)
    if (constraints[key] === undefined && parent[key])
      result[key] = structuredClone(parent[key]);
  if (parent.availableModelsMatch === "exact")
    result.availableModelsMatch = "exact";

  const permissions = object(parent.permissions);
  const managedNetwork = object(object(constraints.sandbox)?.network);
  const managedFilesystem = object(object(constraints.sandbox)?.filesystem);
  if (permissions) {
    const projected: SettingsRecord = {};
    for (const key of ["deny", "ask"]) {
      const rules = permissions[key];
      // Invalid policy-field substitution is the separate tolerant schema's job.
      if (Array.isArray(rules))
        projected[key] = rules.filter(
          (rule): rule is string =>
            typeof rule === "string" && !pathException.test(rule),
        );
    }
    for (const key of ["disableBypassPermissionsMode", "disableAutoMode"])
      if (permissions[key] === "disable") projected[key] = "disable";
    for (const key of [
      "blockReadsOutsideWorkingDirectories",
      "blockWritesOutsideWorkingDirectories",
      "denyInsteadOfPrompting",
    ])
      if (permissions[key] === true) projected[key] = true;
    if (constraints.allowManagedPermissionRulesOnly !== true) {
      if (permissions.allow && managedNetwork?.allowManagedDomainsOnly !== true)
        projected.allow = structuredClone(permissions.allow);
      if (permissions.additionalDirectories)
        projected.additionalDirectories = structuredClone(
          permissions.additionalDirectories,
        );
    }
    if (Object.keys(projected).length) result.permissions = projected;
  }

  const sandbox = object(parent.sandbox);
  if (sandbox) {
    const projected: SettingsRecord = {};
    const network = object(sandbox.network),
      filesystem = object(sandbox.filesystem),
      credentials = object(sandbox.credentials);
    if (network) {
      const value: SettingsRecord = {};
      copy(value, network, ["deniedDomains"]);
      if (
        managedNetwork?.allowManagedDomainsOnly !== true &&
        network.allowedDomains
      )
        value.allowedDomains = structuredClone(network.allowedDomains);
      if (Object.keys(value).length) projected.network = value;
    }
    if (filesystem) {
      const value: SettingsRecord = {};
      copy(value, filesystem, ["denyRead", "denyWrite"]);
      if (
        managedFilesystem?.allowManagedReadPathsOnly !== true &&
        filesystem.allowRead
      )
        value.allowRead = structuredClone(filesystem.allowRead);
      if (Object.keys(value).length) projected.filesystem = value;
    }
    if (credentials) {
      const value: SettingsRecord = {};
      const files = Array.isArray(credentials.files)
        ? credentials.files.flatMap((item) => {
            const entry = object(item);
            if (!entry || entry.path === undefined) return [];
            return entry.mode === "deny"
              ? [{ path: structuredClone(entry.path), mode: "deny" }]
              : [
                  {
                    path: structuredClone(entry.path),
                    mode: "mask",
                    injectHosts: [],
                  },
                ];
          })
        : [];
      const envVars = Array.isArray(credentials.envVars)
        ? credentials.envVars.flatMap((item) => {
            const entry = object(item);
            return entry?.mode === "deny" && entry.name !== undefined
              ? [{ name: structuredClone(entry.name), mode: "deny" }]
              : [];
          })
        : [];
      if (files.length) value.files = files;
      if (envVars.length) value.envVars = envVars;
      if (object(credentials.sigv4)) {
        const sigv4: SettingsRecord = {};
        for (const shape of ["streaming", "presigned", "sigv4a"])
          if (object(credentials.sigv4)?.[shape] === "deny")
            sigv4[shape] = "deny";
        value.sigv4 = sigv4;
      }
      const conventional = new Set<string>();
      if (Array.isArray(credentials.awsPairs))
        for (const pair of credentials.awsPairs) {
          const entry = object(pair);
          if (!entry) continue;
          for (const key of [
            "accessKeyIdVar",
            "secretAccessKeyVar",
            "sessionTokenVar",
          ]) {
            const name = entry[key];
            if (
              typeof name === "string" &&
              [
                "AWS_ACCESS_KEY_ID",
                "AWS_SECRET_ACCESS_KEY",
                "AWS_SESSION_TOKEN",
              ].includes(name)
            )
              conventional.add(name);
          }
        }
      if (conventional.size)
        value.awsPairs = [...conventional].map((name, index) => ({
          accessKeyIdVar: name,
          secretAccessKeyVar: `_PARENT_PAIR_SUPPRESSOR_${index + 1}_`,
        }));
      if (Object.keys(value).length) projected.credentials = value;
    }
    for (const [path, restrictive] of sandboxFloors)
      if (get(sandbox, path) === restrictive) put(projected, path, restrictive);
    if (Object.keys(projected).length) result.sandbox = projected;
  }
  return result;
}

function mergePolicyValue(
  earlier: JsonValue | undefined,
  later: JsonValue,
  key: string,
): JsonValue {
  if (key === "modelPicker") return structuredClone(later);
  if (Array.isArray(earlier) && Array.isArray(later))
    return key === "fallbackModel"
      ? structuredClone(later)
      : [...new Set([...earlier, ...later])].map((value) =>
          structuredClone(value),
        );
  const left = object(earlier),
    right = object(later);
  if (left && right) return mergePolicyRecord(left, right);
  return structuredClone(later);
}
function mergePolicyRecord(
  left: SettingsRecord,
  right: SettingsRecord,
): SettingsRecord {
  const result = structuredClone(left);
  for (const [name, value] of Object.entries(right))
    Object.defineProperty(result, name, {
      value: mergePolicyValue(left[name], value, name),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return result;
}

/**
 * Ordinary authored filesystem admin + parent composition from yD/eki.
 * Remote/MDM/helper precedence, held files and malformed-policy substitutes are
 * resolved before this boundary; never pass an unparsed raw admin document.
 */
export function composeFileManagedParentSettings(
  admin: SettingsRecord | null,
  parent: SettingsRecord | null,
  options: {
    /** Source defaults to merge only for a host-managed gateway lineage. */
    defaultParentSettingsBehavior?: "first-wins" | "merge";
    rawParent?: SettingsRecord;
  } = {},
): {
  settings: SettingsRecord;
  projectedParent: SettingsRecord;
  parentAdmitted: boolean;
} {
  const adminPresent =
    admin !== null &&
    Object.keys(admin).some(
      (key) =>
        key !== "managedSourcesBehavior" &&
        key !== "wslInheritsWindowsSettings",
    );
  const managed = adminPresent ? structuredClone(admin) : {};
  delete managed.managedSourcesBehavior;
  const parentAdmitted =
    !adminPresent ||
    (managed.parentSettingsBehavior ??
      options.defaultParentSettingsBehavior ??
      "first-wins") === "merge";
  const constraints: SettingsRecord = {};
  copy(constraints, managed, [
    ...allowlists,
    "forceLoginOrgUUID",
    "hooks",
    "enabledPlugins",
  ]);
  if (managed.allowManagedPermissionRulesOnly === true)
    constraints.allowManagedPermissionRulesOnly = true;
  if (get(managed, ["sandbox", "network", "allowManagedDomainsOnly"]) === true)
    put(constraints, ["sandbox", "network", "allowManagedDomainsOnly"], true);
  if (
    get(managed, ["sandbox", "filesystem", "allowManagedReadPathsOnly"]) ===
    true
  )
    put(
      constraints,
      ["sandbox", "filesystem", "allowManagedReadPathsOnly"],
      true,
    );
  const rawDisableHooks = options.rawParent?.disableAllHooks;
  const rawForcesHookRestriction =
    rawDisableHooks !== undefined &&
    rawDisableHooks !== null &&
    rawDisableHooks !== false &&
    rawDisableHooks !== "false";
  const projectedParent =
    parentAdmitted && (parent !== null || rawForcesHookRestriction)
      ? projectManagedParentSettings(
          parent ?? {},
          constraints,
          options.rawParent ?? parent ?? {},
        )
      : {};
  const settings = mergePolicyRecord(projectedParent, managed);
  // eki reasserts these parent floors after merging administrator values. It
  // does not apply this override to every projected boolean indiscriminately.
  if (projectedParent.availableModelsMatch === "exact")
    settings.availableModelsMatch = "exact";
  for (const key of [
    "allowManagedHooksOnly",
    "disableSkillShellExecution",
    "disableWindowsBashCommandSplit",
    "disableRemoteControl",
    "disableAgentView",
    "disableWorkflows",
    "disableArtifact",
  ])
    if (projectedParent[key] === true) settings[key] = true;
  for (const key of ["enableWorkflows", "enableArtifact"])
    if (projectedParent[key] === false) settings[key] = false;
  return { settings, projectedParent, parentAdmitted };
}
