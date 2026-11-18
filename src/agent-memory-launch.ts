import { realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  agentMemoryRegistryOptions,
  createAgentMemorySession,
  type AgentMemorySessionFacts,
} from "./agent-memory-session.js";
import {
  autoMemoryReadAllowed,
  autoMemoryWriteAllowed,
  resolveAutoMemoryStore,
  type AutoMemoryFacts,
} from "./auto-memory.js";
import { inspectNativePosixPermissionPath } from "./native-file-permission-host.js";
import { sensitiveWriteReason } from "./permission-sensitive.js";
import {
  inheritedReadDeny,
  matchingToolRule,
  type ToolPolicy,
} from "./tool-policy.js";
import { triBoolean } from "./env-settings.js";
import type { LaunchConfiguration } from "./launch-configuration.js";
import type { PermissionMode } from "./types.js";

/** Concrete ordinary local host. Native account/managed-memory services are separate capabilities. */
export function createLaunchAgentMemoryHost(options: {
  cwd: string;
  launch: LaunchConfiguration;
  model(): string;
  env?: NodeJS.ProcessEnv;
  /** Already selected through the native canonical project host, never guessed from cwd. */
  remoteProjectKey?: string;
}) {
  const env = options.env ?? process.env;
  const initialModel = options.model();
  const roots = {
    workingDirectory: options.cwd,
    configurationDirectory: options.launch.userConfigDir,
    ...(env.CLAUDE_CODE_REMOTE_MEMORY_DIR
      ? {
          remoteMemoryDirectory: resolve(
            options.cwd,
            env.CLAUDE_CODE_REMOTE_MEMORY_DIR,
          ),
          ...(options.remoteProjectKey === undefined
            ? {}
            : { remoteProjectKey: options.remoteProjectKey }),
        }
      : {}),
  };
  const settingsPaths = options.launch.snapshot.documents.flatMap((document) =>
    document.path ? [resolve(document.path)] : [],
  );
  const protectedPaths = () =>
    Promise.all(
      settingsPaths.map(async (path) => {
        try {
          return [path, await realpath(path)];
        } catch {
          return [path];
        }
      }),
    ).then((paths) => new Set(paths.flat()));
  const facts = (): AgentMemorySessionFacts => ({
    session: { memoryToggledOff: false, autoMemoryOffThisSession: false },
    // This standalone CLI has no native restricted/confinement/account host.
    profile: { safeMode: false, restricted: false, confined: false },
    environment: env,
    settings:
      typeof options.launch.snapshot.effective.autoMemoryEnabled === "boolean"
        ? {
            autoMemoryEnabled:
              options.launch.snapshot.effective.autoMemoryEnabled,
          }
        : {},
    modelSelection: {
      initialMainLoopModel: initialModel,
      ...(options.model() === initialModel
        ? {}
        : { mainLoopModelOverride: options.model() }),
    },
    // No native feature reader/cache exists here: use its absent-reader defaults.
    features: { disabledModelPatterns: [], disableMatchingModels: false },
    filePolicy: {
      remoteSurface: triBoolean(env.CLAUDE_CODE_REMOTE) === true,
      blockOutsideReads: false,
      blockOutsideWrites: false,
    },
  });
  const settings: AutoMemoryFacts["settings"] = {
    policySettings: options.launch.snapshot.policy.autoMemoryDirectory,
  };
  for (const source of [
    "flagSettings",
    "localSettings",
    "projectSettings",
    "userSettings",
  ] as const)
    if (options.launch.snapshot.enabledSources.includes(source))
      settings[source] = options.launch.snapshot.documents.find(
        (document) =>
          document.source === source && document.status === "loaded",
      )?.effective?.autoMemoryDirectory;
  const autoMemory = resolveAutoMemoryStore({
    enabled: agentMemoryRegistryOptions(facts()).memoryEnabled,
    env,
    configDirectory: options.launch.userConfigDir,
    home: options.launch.importHome,
    cwd: options.cwd,
    canonicalGitRoot: options.launch.workspace.canonicalGitRoot,
    settings,
    projectSettingsAdmitted:
      options.launch.workspace.currentWorkspaceTrusted &&
      triBoolean(env.CLAUDE_CODE_IGNORE_PERSISTED_TRUST) !== true,
  });
  /** Source vct/permission floors shared by agent and auto memory allowances. */
  const floors = async (
    policy: (() => ToolPolicy) | undefined,
    mode: (() => PermissionMode) | undefined,
    operation: "Read" | "Write" | "Edit",
    paths: readonly string[],
    signal: AbortSignal,
  ): Promise<boolean> => {
    signal.throwIfAborted();
    const current = policy?.();
    if (!current || !mode || mode() === "plan") return false;
    if (current.tools !== undefined && !current.tools.includes(operation))
      return false;
    if (
      matchingToolRule(current, "deny", operation) ||
      matchingToolRule(current, "ask", operation)
    )
      return false;
    if (operation !== "Read" && inheritedReadDeny(current)) return false;
    if (operation === "Read") return true;
    const protectedSet = await protectedPaths();
    for (const path of paths) {
      if (
        protectedSet.has(path) ||
        sensitiveWriteReason(path, options.cwd, settingsPaths, {
          admittedAgentMemory: true,
        })
      )
        return false;
      try {
        const leaf = await lstat(path);
        if (leaf.isSymbolicLink() || (leaf.isFile() && leaf.nlink !== 1))
          return false;
      } catch (error) {
        if (!(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          return false;
      }
    }
    signal.throwIfAborted();
    // The actual executor still owns hook asks, read baselines and final write checks.
    return true;
  };
  /** The physical folder, so an aliased config root (macOS /var) still matches its landing. */
  const physical = (directory: string | null) => {
    if (directory === null) return null;
    try {
      return realpathSync(directory).normalize("NFC") + sep;
    } catch {
      return directory;
    }
  };
  /** The requested spelling and the landing must both fall inside the allowance. */
  const autoMemoryIdentity = (operation: string, requestedPath: string) => {
    const allowed =
      operation === "Read"
        ? autoMemoryReadAllowed
        : operation === "Write" || operation === "Edit"
          ? autoMemoryWriteAllowed
          : undefined;
    const requested = resolve(options.cwd, requestedPath);
    if (!allowed?.(autoMemory, requested)) return;
    const identity = inspectNativePosixPermissionPath({
      path: requested,
      cwd: options.cwd,
      home: options.launch.importHome,
    });
    if (identity.status !== "resolved") return;
    const landed = {
      ...autoMemory,
      directory: physical(autoMemory.directory) ?? autoMemory.directory,
      ownProjectDirectory: physical(autoMemory.ownProjectDirectory),
    };
    return allowed(autoMemory, identity.landing) ||
      allowed(landed, identity.landing)
      ? { landing: identity.landing, paths: [requested, identity.landing] }
      : undefined;
  };
  const session = (policy?: () => ToolPolicy, mode?: () => PermissionMode) =>
    createAgentMemorySession({
      roots,
      facts,
      admitDefinition: (definition, signal) => {
        signal.throwIfAborted();
        return (
          definition.source !== "projectSettings" ||
          options.launch.workspace.currentWorkspaceTrusted
        );
      },
      authorizePromptResource: ({ canonicalPath, signal }) => {
        signal.throwIfAborted();
        return canonicalPath !== undefined;
      },
      resolveFileIdentity: async ({ requestedPath, signal }) => {
        signal.throwIfAborted();
        const identity = inspectNativePosixPermissionPath({
          path: requestedPath,
          cwd: options.cwd,
          home: options.launch.importHome,
        });
        if (identity.status !== "resolved")
          throw new Error("Agent memory file identity is unresolved");
        return { canonicalPath: identity.landing, paths: identity.spellings };
      },
      admitFileIdentity: ({ operation, signal }) => {
        signal.throwIfAborted();
        // Remote native surfaces need their own outside-read host. This admits no ask.
        return operation !== "Read" || !facts().filePolicy.remoteSurface;
      },
      authorizeFileFloors: ({ operation, paths, signal }) =>
        floors(policy, mode, operation, paths, signal),
    });
  const prompt = session();
  return {
    autoMemory,
    registryOptions: () => prompt.registryOptions(),
    prepare: (...args: Parameters<typeof prompt.prepare>) =>
      prompt.prepare(...args),
    fileAccess(policy: () => ToolPolicy, mode: () => PermissionMode) {
      const access = session(policy, mode).fileAccess;
      return {
        extraPathAdmission: async (
          request: Parameters<typeof access.extraPathAdmission>[0],
        ) =>
          (await access.extraPathAdmission(request)) ??
          autoMemoryIdentity(request.operation, request.requestedPath)?.landing,
        memoryFileAllowance: async (
          request: Parameters<typeof access.automaticFileAllowance>[0],
        ) => {
          if (await access.automaticFileAllowance(request)) return true;
          const identity = autoMemoryIdentity(
            request.operation,
            request.requestedPath,
          );
          return (
            identity?.landing === resolve(request.canonicalPath) &&
            (await floors(
              policy,
              mode,
              request.operation,
              identity.paths,
              request.signal,
            ))
          );
        },
      };
    },
  };
}
