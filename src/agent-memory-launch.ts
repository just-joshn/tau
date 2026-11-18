import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createAgentMemorySession,
  type AgentMemorySessionFacts,
} from "./agent-memory-session.js";
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
      authorizeFileFloors: async ({ operation, paths, signal }) => {
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
      },
    });
  const prompt = session();
  return {
    registryOptions: () => prompt.registryOptions(),
    prepare: (...args: Parameters<typeof prompt.prepare>) =>
      prompt.prepare(...args),
    fileAccess(policy: () => ToolPolicy, mode: () => PermissionMode) {
      const access = session(policy, mode).fileAccess;
      return {
        extraPathAdmission: access.extraPathAdmission,
        memoryFileAllowance: access.automaticFileAllowance,
      };
    },
  };
}
