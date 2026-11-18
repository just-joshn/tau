import { isAbsolute, resolve } from "node:path";
import type { LocalAgentDefinition } from "./agent-definitions.js";
import {
  agentMemoryAutomaticFileAllowance,
  agentMemoryEnabled,
  createAgentMemoryHost,
  recognizeAgentMemoryPath,
  type AgentMemoryAccess,
  type AgentMemoryContext,
  type AgentMemoryGate,
  type AgentMemoryRoots,
} from "./agent-memory.js";

export interface AgentMemorySessionFacts {
  session: { memoryToggledOff: boolean; autoMemoryOffThisSession: boolean };
  /** Already-resolved host launch/confinement facts; no account or trust inference. */
  profile: { safeMode: boolean; restricted: boolean; confined: boolean };
  environment: Readonly<Record<string, string | undefined>>;
  settings: { autoMemoryEnabled?: boolean };
  /** Source YAn reads host model selection, not the child's declared model. */
  modelSelection: {
    mainLoopModelOverride?: string;
    initialMainLoopModel?: string;
  };
  /** Admitted feature values: tengu_sepia_cormorant and tengu_umber_petrel. */
  features?: {
    disabledModelPatterns?: readonly unknown[];
    disableMatchingModels?: boolean;
  };
  /** Source file-policy facts, separate from prompt enablement. */
  filePolicy: {
    remoteSurface: boolean;
    blockOutsideReads: boolean;
    blockOutsideWrites: boolean;
  };
}
const trueEnvironment = (value: string | undefined): boolean =>
  value !== undefined &&
  ["1", "true", "yes", "on"].includes(value.toLowerCase().trim());

/** Source qPe/QFe: literal substring, with a narrow year-suffix collision guard. */
export function agentMemoryModelPolicyDisablesMemory(
  selection: AgentMemorySessionFacts["modelSelection"],
  features: AgentMemorySessionFacts["features"],
): boolean {
  const patterns = features?.disabledModelPatterns;
  if (!patterns?.length) return false;
  const model =
    selection.mainLoopModelOverride !== undefined
      ? selection.mainLoopModelOverride
      : selection.initialMainLoopModel;
  if (typeof model !== "string") return false;
  const lower = model.toLowerCase();
  for (const value of patterns) {
    if (typeof value !== "string" || value.length === 0) continue;
    const pattern = value.toLowerCase(),
      guarded = /[-_]\d$/.test(pattern);
    for (
      let index = lower.indexOf(pattern);
      index !== -1;
      index = lower.indexOf(pattern, index + 1)
    ) {
      if (!guarded || !/^\d{3}/.test(lower.slice(index + pattern.length)))
        return features?.disableMatchingModels === true;
    }
  }
  return false;
}
export function resolveAgentMemorySessionGate(
  facts: AgentMemorySessionFacts,
): AgentMemoryGate {
  const env = facts.environment;
  return Object.freeze({
    ...facts.session,
    safeMode:
      facts.profile.safeMode || trueEnvironment(env.CLAUDE_CODE_SAFE_MODE),
    restricted: facts.profile.restricted,
    confined: facts.profile.confined,
    disableAutoMemory: env.CLAUDE_CODE_DISABLE_AUTO_MEMORY,
    simple: trueEnvironment(env.CLAUDE_CODE_SIMPLE),
    remoteWithoutMemoryRoot:
      trueEnvironment(env.CLAUDE_CODE_REMOTE) &&
      !env.CLAUDE_CODE_REMOTE_MEMORY_DIR &&
      !env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE?.trim(),
    modelGateDisablesMemory: agentMemoryModelPolicyDisablesMemory(
      facts.modelSelection,
      facts.features,
    ),
    autoMemoryEnabled: facts.settings.autoMemoryEnabled,
  });
}
/** Snapshot for definition parsing; actual prompt preparation uses live Gg facts again. */
export function agentMemoryRegistryOptions(
  facts: AgentMemorySessionFacts,
): Readonly<{ memoryEnabled: boolean }> {
  return Object.freeze({
    memoryEnabled: agentMemoryEnabled(resolveAgentMemorySessionGate(facts)),
  });
}

export type AgentMemoryFileOperation = "Read" | "Write" | "Edit";
export interface AgentMemoryFileIdentity {
  canonicalPath: string;
  /** All additional host-resolved spellings/targets that its path policy must evaluate. */
  paths: readonly string[];
}
export interface AgentMemoryFileRequest {
  operation: AgentMemoryFileOperation;
  requestedPath: string;
  signal: AbortSignal;
}
export interface AgentMemoryAdmittedIdentity extends AgentMemoryFileRequest {
  canonicalPath: string;
  paths: readonly string[];
}
export interface AgentMemoryAllowanceRequest extends AgentMemoryFileRequest {
  /** The executor's current identity, checked against fresh resolution before eligibility. */
  canonicalPath: string;
}
export interface AgentMemoryAllowanceContext extends AgentMemoryAdmittedIdentity {
  /** Native lexical candidate only; it is never a grant. */
  nativeCandidate: boolean;
  /** Stricter host extension, not an interpretation of native of/CEe. */
  allPathsRecognized: boolean;
}
export interface AgentMemorySessionOptions {
  roots: AgentMemoryRoots;
  facts(): AgentMemorySessionFacts;
  admitDefinition(
    definition: Readonly<LocalAgentDefinition>,
    signal: AbortSignal,
  ): boolean | Promise<boolean>;
  /** Prompt resource admission is independent of ordinary Read permission rules. */
  authorizePromptResource(
    access: AgentMemoryAccess,
  ): boolean | Promise<boolean>;
  resolveFileIdentity(
    request: Readonly<AgentMemoryFileRequest>,
  ): Promise<AgentMemoryFileIdentity>;
  /** Identity/resource admission only: never reject merely because later permission needs an ask. */
  admitFileIdentity(
    identity: Readonly<AgentMemoryAdmittedIdentity>,
  ): boolean | Promise<boolean>;
  /** Required current parent/tool-pool/deny/ask/mode/protected-target/baseline capability check.
   * Native memory allowance precedes the broad generic .claude-directory sensitive hold;
   * preserve specific settings/execution/credential holds rather than blanket-blocking that directory.
   * False holds only the automatic candidate; the ordinary permission flow must continue.
   * This callback cannot waive executor read-before-write/race checks or approve an ask. */
  authorizeFileFloors(
    context: Readonly<AgentMemoryAllowanceContext>,
  ): boolean | Promise<boolean>;
  readPrimedUserIndex?(
    name: string,
    signal: AbortSignal,
  ): Promise<string | undefined>;
  maxReadBytes?: number;
}
const absolute = (path: string): string => {
  if (!isAbsolute(path) || path.includes("\0"))
    throw new TypeError("Absolute memory file identity required");
  return resolve(path);
};
function operation(value: string): value is AgentMemoryFileOperation {
  return value === "Read" || value === "Write" || value === "Edit";
}
export interface PreparedAgentMemorySession {
  enabled: boolean;
  systemPrompt: string;
  /** The adapter understands disabled memory metadata too; no permission is implied. */
  handledFeatures: readonly "memory"[];
  context?: AgentMemoryContext;
}
export function createAgentMemorySession(options: AgentMemorySessionOptions) {
  const roots = Object.freeze({ ...options.roots });
  const enabled = () =>
    agentMemoryEnabled(resolveAgentMemorySessionGate(options.facts()));
  const host = createAgentMemoryHost({
    roots,
    enabled,
    admitDefinition: (definition, signal) =>
      options.admitDefinition(definition, signal),
    authorize: (access) => options.authorizePromptResource(access),
    ...(options.readPrimedUserIndex
      ? {
          readPrimedUserIndex: async (name: string, signal: AbortSignal) =>
            options.readPrimedUserIndex?.(name, signal),
        }
      : {}),
    ...(options.maxReadBytes === undefined
      ? {}
      : { maxReadBytes: options.maxReadBytes }),
  });
  async function identity(
    request: AgentMemoryFileRequest,
  ): Promise<Readonly<AgentMemoryAdmittedIdentity> | undefined> {
    request.signal.throwIfAborted();
    const requestedPath = absolute(request.requestedPath);
    if (!recognizeAgentMemoryPath(requestedPath, roots)) return;
    const resolved = await options.resolveFileIdentity(
      Object.freeze({ ...request, requestedPath }),
    );
    request.signal.throwIfAborted();
    const canonicalPath = absolute(resolved.canonicalPath);
    const paths = Object.freeze([
      ...new Set([
        requestedPath,
        canonicalPath,
        ...resolved.paths.map(absolute),
      ]),
    ]);
    // Source recognition is lexical; evaluating every target here is an explicit host floor.
    if (
      !paths.every(
        (path) => recognizeAgentMemoryPath(path, roots) !== undefined,
      )
    )
      return;
    const result = Object.freeze({
      ...request,
      requestedPath,
      canonicalPath,
      paths,
    });
    if (!(await options.admitFileIdentity(result))) return;
    request.signal.throwIfAborted();
    return result;
  }
  const nativeCandidate = (request: AgentMemoryFileRequest): boolean => {
    const facts = options.facts();
    return agentMemoryAutomaticFileAllowance(
      absolute(request.requestedPath),
      request.operation === "Read" ? "read" : "write",
      roots,
      {
        confined: facts.profile.confined,
        restricted: facts.profile.restricted,
        ...facts.filePolicy,
      },
    );
  };
  return Object.freeze({
    registryOptions: () => agentMemoryRegistryOptions(options.facts()),
    async prepare(
      definition: Readonly<LocalAgentDefinition>,
      signal: AbortSignal,
    ): Promise<PreparedAgentMemorySession> {
      signal.throwIfAborted();
      if (!definition.memory)
        return Object.freeze({
          enabled: false,
          systemPrompt: "",
          handledFeatures: Object.freeze([]),
        });
      const context = await host.prepare(definition, signal);
      signal.throwIfAborted();
      return Object.freeze({
        enabled: context.enabled,
        systemPrompt: context.prompt,
        handledFeatures: Object.freeze<"memory"[]>(["memory"]),
        context,
      });
    },
    nativeFileAllowanceCandidate: nativeCandidate,
    fileAccess: Object.freeze({
      async extraPathAdmission(request: {
        operation: string;
        requestedPath: string;
        signal?: AbortSignal;
      }): Promise<string | undefined> {
        if (!operation(request.operation)) return;
        if (!request.signal)
          throw new Error("Memory path admission requires an operation signal");
        const admitted = await identity({
          ...request,
          operation: request.operation,
          signal: request.signal,
        });
        return admitted?.canonicalPath;
      },
      async automaticFileAllowance(
        request: AgentMemoryAllowanceRequest,
      ): Promise<boolean> {
        request.signal.throwIfAborted();
        if (!nativeCandidate(request)) return false;
        const admitted = await identity(request);
        if (
          !admitted ||
          admitted.canonicalPath !== absolute(request.canonicalPath)
        )
          return false;
        const context = Object.freeze({
          ...admitted,
          nativeCandidate: true,
          allPathsRecognized: true,
        });
        if (!(await options.authorizeFileFloors(context))) return false;
        request.signal.throwIfAborted();
        // Live source policy can change while host permission checks await.
        return nativeCandidate(request);
      },
    }),
  });
}
