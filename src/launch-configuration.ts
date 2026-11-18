import { homedir } from "node:os";
import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  readBoundedConfigurationText,
  resolveConfiguration,
  SETTINGS_MAX_BYTES,
  type ConfigurationSnapshot,
  type SettingsInput,
  type SettingsRecord,
} from "./configuration.js";
import {
  inspectWorkspaceConfiguration,
  type WorkspaceConfiguration,
} from "./workspace-configuration.js";
import type { Options } from "./options.js";

export interface LaunchConfiguration {
  snapshot: ConfigurationSnapshot;
  userConfigDir: string;
  globalConfigPath: string;
  /** Exact persisted project records; session/ancestor acceptance is a separate channel. */
  trustedProjectKeys?: readonly string[];
  workspace: WorkspaceConfiguration;
  managedRoot?: string;
  importHome: string;
  model: string;
  fallbackModel?: string;
  mode: Options["mode"];
}

function document(value: string): SettingsInput {
  if (!value.trimStart().startsWith("{")) return { path: value };
  try {
    return { inline: JSON.parse(value) };
  } catch {
    throw new Error("Invalid inline settings JSON");
  }
}
function managedDirectory(platform: NodeJS.Platform): string {
  return platform === "darwin"
    ? "/Library/Application Support/ClaudeCode"
    : platform === "win32"
      ? "C:\\Program Files\\ClaudeCode"
      : "/etc/claude-code";
}
const record = (value: unknown): value is SettingsRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Ordinary local Q_ selection. This reads metadata; it does not migrate state. */
export async function resolveGlobalConfigPath(
  userConfigDir: string,
  normalPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const legacy = join(userConfigDir, ".config.json");
  try {
    const old = await stat(legacy);
    if (!old.isFile() || (old.size === 0 && (old.mode & 0o222) === 0))
      return normalPath;
    let normal: Stats | undefined;
    try {
      normal = await stat(normalPath);
    } catch (error) {
      if (
        (typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT") ||
        old.size === 0
      )
        return legacy;
    }
    if (
      old.size === 0 &&
      normal &&
      platform === "linux" &&
      normal.isFile() &&
      normal.size === 0 &&
      (normal.mode & 0o222) === 0 &&
      normal.nlink === 1
    )
      return legacy;
    if (old.size > 0) {
      if (normal && (!normal.isFile() || normal.size === 0)) return legacy;
      try {
        if (!(await readdir(dirname(legacy))).includes(basename(legacy)))
          return normalPath;
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return normalPath;
      }
      return legacy;
    }
  } catch {
    /* The ordinary file is the fallback when the legacy probe fails. */
  }
  return normalPath;
}

/** Resolve launch inputs before constructing providers or tool permission catalogs. */
export async function loadLaunchConfiguration(
  options: Options,
  inputs: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    platform?: NodeJS.Platform;
    nonInteractive?: boolean;
    workspaceTrustAccepted?: boolean;
    signal?: AbortSignal;
  },
): Promise<LaunchConfiguration> {
  const env = inputs.env ?? process.env,
    homeDirectory = inputs.homeDirectory ?? homedir();
  const userConfigDir = resolve(
    env.CLAUDE_CONFIG_DIR ?? join(homeDirectory, ".claude"),
  ).normalize("NFC");
  const managedRoot =
    env.TAU_MANAGED_ROOT ??
    managedDirectory(inputs.platform ?? process.platform);
  if (!isAbsolute(managedRoot))
    throw new Error("TAU_MANAGED_ROOT must be an absolute directory");
  const globalConfigPath = await resolveGlobalConfigPath(
    userConfigDir,
    resolve(env.CLAUDE_CONFIG_DIR || homeDirectory, ".claude.json"),
    inputs.platform,
  );
  // Only the persisted trust keys are carried forward. Account, credential and
  // unrelated global settings are not part of the launch snapshot.
  const trustedProjectKeys: string[] = [];
  const global = await readBoundedConfigurationText(
    globalConfigPath,
    SETTINGS_MAX_BYTES,
  );
  if (global.status === "loaded")
    try {
      const parsed: unknown = JSON.parse(global.text.replace(/^\uFEFF/, ""));
      if (record(parsed) && record(parsed.projects))
        for (const [key, value] of Object.entries(parsed.projects)) {
          if (record(value) && value.hasTrustDialogAccepted === true)
            trustedProjectKeys.push(key);
        }
    } catch {
      /* Global configuration diagnostics are reported by its loader. */
    }
  const workspace = await inspectWorkspaceConfiguration({
    cwd: inputs.cwd,
    configDirectory: userConfigDir,
    homeDirectory,
    workspaceTrustAccepted:
      inputs.workspaceTrustAccepted ?? inputs.nonInteractive ?? options.print,
    trustedProjectKeys,
    env,
    ...(inputs.signal === undefined ? {} : { signal: inputs.signal }),
  });
  let parentPolicy: SettingsInput | undefined;
  if (options.managedSettings !== undefined) {
    try {
      parentPolicy = { inline: JSON.parse(options.managedSettings) };
    } catch {
      throw new Error("--managed-settings requires inline JSON");
    }
  }
  const snapshot = await resolveConfiguration({
    cwd: inputs.cwd,
    userConfigDir,
    ...(workspace.localStore === undefined
      ? {}
      : { localStoreRoot: workspace.localStore.root }),
    ...(workspace.legacyLocalSettingsPath === undefined
      ? {}
      : { legacyLocalRoot: inputs.cwd }),
    managedRoot,
    ...(parentPolicy === undefined ? {} : { parent: parentPolicy }),
    ...(options.settingSources === undefined
      ? {}
      : { allowedSources: options.settingSources }),
    ...(options.settings === undefined
      ? {}
      : { flag: document(options.settings) }),
    permissionTrust: {
      projectAllows: workspace.projectPermissionAllowsAdmitted,
      localAllows: workspace.localPermissionAllowsAdmitted,
    },
  });
  const explicit = snapshot.documents.find(
    (document) => document.source === "flagSettings",
  );
  if (options.settings !== undefined && explicit?.status !== "loaded")
    throw new Error(
      `Cannot load --settings: ${explicit?.diagnostics[0]?.message ?? explicit?.path ?? options.settings}`,
    );
  const model =
    options.modelExplicit || Boolean(env.ANTHROPIC_MODEL)
      ? options.model
      : typeof snapshot.effective.model === "string" && snapshot.effective.model
        ? snapshot.effective.model
        : options.model;
  const configuredFallback = snapshot.effective.fallbackModel;
  const fallbackModel =
    options.fallbackModel ??
    (typeof configuredFallback === "string"
      ? configuredFallback
      : Array.isArray(configuredFallback) &&
          configuredFallback.every((value) => typeof value === "string")
        ? configuredFallback.join(",")
        : undefined);
  const permissions = snapshot.effective.permissions;
  const configuredMode = record(permissions)
    ? permissions.defaultMode
    : undefined;
  const isMode = (value: unknown): value is Options["mode"] =>
    value === "default" ||
    value === "acceptEdits" ||
    value === "plan" ||
    value === "bypassPermissions";
  const mode =
    !options.modeExplicit && isMode(configuredMode)
      ? configuredMode
      : options.mode;
  return {
    snapshot,
    userConfigDir,
    globalConfigPath,
    trustedProjectKeys,
    workspace,
    managedRoot,
    importHome: homeDirectory,
    model,
    mode,
    ...(fallbackModel === undefined ? {} : { fallbackModel }),
  };
}
